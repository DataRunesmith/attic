#!/bin/sh
set -eu
umask 077

data=${DATA_DIR:-/data}
settings=$data/settings.env
import=$data/import.env
[ -d "$data" ] && [ ! -L "$data" ] || { echo "$data must be an existing, non-symlink directory." >&2; exit 1; }
[ ! -L "$import" ] || { echo "$import must not be a symlink." >&2; exit 1; }
if [ -L "$settings" ] || { [ -e "$settings" ] && [ ! -f "$settings" ]; }; then
  echo "$settings must be a regular file, not a symlink or directory." >&2
  exit 1
fi
[ ! -f "$settings" ] || chmod 600 "$settings"

raw=
merged=
cleanup() {
  [ -z "$raw" ] || rm -f "$raw"
  [ -z "$merged" ] || rm -f "$merged"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Recover every previously claimed import. A new import.env is claimed last
# and therefore takes precedence over older pending values with the same key.
set --
for candidate in "$data"/.import.claim.*/import.env; do
  [ -f "$candidate" ] || continue
  [ ! -L "$candidate" ] || { echo "A pending import must not be a symlink." >&2; exit 1; }
  claim_dir=${candidate%/import.env}
  [ ! -L "$claim_dir" ] || { echo "A pending import directory must not be a symlink." >&2; exit 1; }
  set -- "$@" "$candidate"
done

if [ -f "$import" ]; then
  new_claim_dir=$(mktemp -d "$data/.import.claim.XXXXXX")
  new_claim=$new_claim_dir/import.env
  if ! mv "$import" "$new_claim"; then
    rmdir "$new_claim_dir"
    echo "Could not claim $import for import." >&2
    exit 1
  fi
  [ ! -L "$new_claim" ] || { echo "Claimed import must not be a symlink." >&2; exit 1; }
  set -- "$@" "$new_claim"
fi

if [ "$#" -gt 0 ]; then
  raw=$(mktemp "$data/.settings.raw.XXXXXX")
  merged=$(mktemp "$data/.settings.env.XXXXXX")
  if [ -f "$settings" ]; then
    [ -r "$settings" ] || { echo "Cannot read $settings." >&2; exit 1; }
    cat "$settings" >"$raw"
  else
    : >"$raw"
  fi
  for candidate do
    [ -f "$candidate" ] || continue
    [ -r "$candidate" ] || { echo "Cannot read pending import $candidate." >&2; exit 1; }
    cat "$candidate" >>"$raw"
  done
  awk -F= '
    /^[A-Z][A-Z0-9_]*=/ {
      name = $1
      value[name] = substr($0, length(name) + 2)
      if (!(name in seen)) { seen[name] = 1; order[++n] = name }
    }
    END {
      for (i = 1; i <= n; i++)
        if (value[order[i]] != "") print order[i] "=" value[order[i]]
    }
  ' "$raw" >"$merged"
  chmod 600 "$merged"
  mv -f "$merged" "$settings"
  merged=
  rm -f "$raw"
  raw=

  # Claims are removed only after the merged settings file is committed.
  for candidate do
    if rm -f "$candidate"; then
      rmdir "${candidate%/import.env}" 2>/dev/null || :
    else
      echo "Could not remove processed import $candidate; it will be retried." >&2
    fi
  done
fi

if [ -f "$settings" ]; then
  while IFS= read -r line; do
    case "$line" in
      [A-Z]*=*)
        name=${line%%=*}
        case "$name" in ""|*[!A-Z0-9_]*) continue ;; esac
        [ -n "$(printenv "$name" || true)" ] || export "$line"
        ;;
    esac
  done <"$settings"
fi
