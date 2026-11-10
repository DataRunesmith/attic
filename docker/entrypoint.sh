#!/bin/sh
# Renders the gallery with the values from the container environment and
# serves the Worker with R2 stored under /data. Secrets reach wrangler through a
# private env file; nothing is baked into the image.
set -eu

# Saved settings from a one-time /data/import.env (see import-settings.sh).
. /opt/app/docker/import-settings.sh

: "${PUBLIC_URL:=http://localhost:8787}"
PUBLIC_URL=${PUBLIC_URL%/}
node -e 'const u = new URL(process.argv[1]); if (!["http:", "https:"].includes(u.protocol) || !u.hostname || u.username || u.password || u.pathname !== "/" || u.search || u.hash) process.exit(1)' "$PUBLIC_URL" ||
  { echo "PUBLIC_URL must be an HTTP(S) origin without credentials, path, query, or fragment." >&2; exit 1; }
: "${AUTH_MODE:=password}"
case "$AUTH_MODE" in
  password)
    [ "${#ADMIN_PASSWORD}" -ge 8 ] 2>/dev/null ||
      { echo "AUTH_MODE=password needs ADMIN_PASSWORD (at least 8 characters)." >&2; exit 1; } ;;
  cloudflare-access)
    [ -n "${CF_ACCESS_TEAM_DOMAIN:-}" ] && [ -n "${CF_ACCESS_AUD:-}" ] ||
      { echo "AUTH_MODE=cloudflare-access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD." >&2; exit 1; }
    node -e 'const v = process.argv[1]; const u = new URL("https://" + v); if (u.hostname !== v || u.pathname !== "/" || u.search || u.hash) process.exit(1)' "$CF_ACCESS_TEAM_DOMAIN" ||
      { echo "CF_ACCESS_TEAM_DOMAIN must be a hostname without scheme or path." >&2; exit 1; } ;;
  *) echo "AUTH_MODE must be password or cloudflare-access." >&2; exit 1 ;;
esac

# Placeholder values; the bucket names match docker/wrangler.jsonc.
export PUBLIC_ORIGIN="$PUBLIC_URL"
PUBLIC_HOST=$(printf '%s' "$PUBLIC_URL" | sed 's|^[a-z]*://||; s|/.*||')
export PUBLIC_HOST GALLERY_BUCKET=gallery LEGACY_BUCKET=legacy SECRETS_STORE_ID=local
export CF_ACCESS_TEAM_DOMAIN="${CF_ACCESS_TEAM_DOMAIN:-}" CF_ACCESS_AUD="${CF_ACCESS_AUD:-}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

app=/opt/app
values=$(mktemp)
trap 'rm -f "$values"' EXIT
sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$app/cloudflare.example.env" | while read -r name; do
  printf '%s=%s\n' "$name" "$(printenv "$name" || true)"
done >"$values"

site=/srv/site
node /opt/app/tools/render.mjs "$values" "$site" >/dev/null
rm -f "$values"
trap - EXIT
cp "$app/docker/wrangler.jsonc" "$site/wrangler.jsonc"

vars=$(mktemp /dev/shm/attic-wrangler.XXXXXX)
chmod 600 "$vars"
newline='
'
cr=$(printf '\r')
append_env() {
  name=$1
  value=$2
  case "$value" in
    *"$newline"*|*"$cr"*)
      echo "Runtime variable $name cannot contain line breaks." >&2
      exit 1
      ;;
  esac
  printf '%s=%s\n' "$name" "$value" >>"$vars"
}
append_env PUBLIC_ORIGIN "$PUBLIC_URL"
append_env GALLERY_PREFIX "gallery/"
append_env LEGACY_BUCKET_NAME "legacy"
append_env AUTH_MODE "$AUTH_MODE"
[ -n "${ADMIN_PASSWORD:-}" ] && append_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
[ -n "$CF_ACCESS_TEAM_DOMAIN" ] && append_env CF_ACCESS_TEAM_DOMAIN "$CF_ACCESS_TEAM_DOMAIN"
[ -n "$CF_ACCESS_AUD" ] && append_env CF_ACCESS_AUD "$CF_ACCESS_AUD"
[ -n "${WORKERS_API_TOKEN:-}" ] && append_env WORKERS_API_TOKEN "$WORKERS_API_TOKEN"
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] && append_env CF_ACCESS_ACCOUNT_ID "$CLOUDFLARE_ACCOUNT_ID"

cd "$site"
exec npx wrangler dev --local --persist-to /data \
  --ip 0.0.0.0 --port "${PORT:-8787}" \
  --env-file "$vars" --show-interactive-dev-session=false
