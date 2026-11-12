#!/bin/sh
# Deploys the app to your Cloudflare account, from start to finish:
#
#   sh tools/deploy.sh .cloudflare.env   values from a file
#   sh tools/deploy.sh                   values from environment variables
#
# The values are the names listed in cloudflare.example.env. They are filled
# into a temporary copy of the repo, which is deployed and then removed, so no
# value ends up in a tracked file. Arguments after the values file go to
# `wrangler deploy`, for example --dry-run.
set -eu
case "${1:-}" in
  "" | -*)
    values=-
    [ "${1:-}" != - ] || shift
    ;;
  *)
    [ -f "$1" ] || { echo "No such values file: $1" >&2; exit 1; }
    values=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
    shift
    ;;
esac
cd "$(dirname "$0")/.."

if [ "$values" = - ]; then
  # A name that is not set counts as empty, so only your own values are needed.
  found=
  for name in $(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' cloudflare.example.env); do
    if [ -n "$(printenv "$name" || true)" ]; then found=1; else export "$name="; fi
  done
  [ -n "$found" ] || {
    echo "No values found. Pass a values file, or set the variables named in cloudflare.example.env." >&2
    exit 1
  }
fi

# The value of a name, from the values file or from the environment.
value_of() {
  if [ "$values" = - ]; then
    printenv "$1" || true
  else
    sed -n "s/^$1=//p" "$values" | tail -n 1
  fi
}

# Wrangler takes its own credentials from the environment; a values file may
# carry them as well.
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -z "$(printenv "$name" || true)" ] || continue
  value=$(value_of "$name")
  [ -z "$value" ] || export "$name=$value"
done

dry_run=
for arg in "$@"; do
  [ "$arg" != --dry-run ] || dry_run=1
done
if [ -z "$dry_run" ]; then
  # Sign-in goes through Cloudflare Access; without these nobody gets in.
  for name in CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD; do
    [ -n "$(value_of "$name")" ] || {
      echo "$name is empty. Sign-in goes through Cloudflare Access, so nobody could sign in to the deployed app." >&2
      exit 1
    }
  done
fi

[ -d node_modules/wrangler ] || npm install --no-package-lock --no-audit --no-fund
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
node tools/render.mjs "$values" "$out/app" >/dev/null
cd "$out/app"
npx wrangler deploy "$@"
