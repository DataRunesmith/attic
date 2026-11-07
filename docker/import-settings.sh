#!/bin/sh
# One-time settings import, sourced by entrypoint.sh.
#
# Put NAME=value lines in /data/import.env and restart the container: the
# values are merged into /data/settings.env (readable only by the container
# user) and import.env is deleted. To change a value later, drop a new
# import.env with just that line; NAME= with nothing after it removes the
# setting. Non-empty variables from docker-compose.yml win over saved ones.

settings=/data/settings.env
import=/data/import.env

if [ -f "$import" ]; then
  merged=$(mktemp)
  # Later lines win: existing settings first, then the import.
  { [ -f "$settings" ] && cat "$settings"; cat "$import"; echo; } |
    awk -F= '/^[A-Z][A-Z0-9_]*=/ { name = $1; value[name] = substr($0, length(name) + 2);
                                    if (!(name in seen)) { seen[name] = 1; order[++n] = name } }
             END { for (i = 1; i <= n; i++) if (value[order[i]] != "") print order[i] "=" value[order[i]] }' \
      >"$merged"
  mv "$merged" "$settings"
  if rm -f "$import" 2>/dev/null && [ ! -e "$import" ]; then
    echo "Imported settings into $settings and deleted $import."
  else
    echo "Imported settings into $settings, but could not delete $import; remove it yourself." >&2
  fi
fi

if [ -f "$settings" ]; then
  while IFS= read -r line; do
    case "$line" in
      [A-Z]*=*)
        name=${line%%=*}
        [ -n "$(printenv "$name" || true)" ] || export "$line"
        ;;
    esac
  done <"$settings"
fi
