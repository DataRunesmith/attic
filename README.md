# Attic

A private image archive for app icons and theme images. A Cloudflare Worker stores images in R2 and sits behind Cloudflare Access. Static frontend assets are embedded into the Worker at build time.

## Cloudflare Workers Builds (GitHub)

Attic requires a render step before Wrangler deploys. The tracked `wrangler.jsonc` is a template; deploying it directly fails because its resource names and route are placeholders.

### One-time setup

1. Create or select a Cloudflare Worker named **attic** and connect it to this GitHub repository under **Settings → Builds**.
2. Copy `.cloudflare.env.example` to `.cloudflare.env` on your computer and fill in the account-specific values.
3. Create a user-scoped Cloudflare API token with **Workers Builds Configuration: Edit** and **Workers Scripts: Read**. Put it in `CLOUDFLARE_API_TOKEN` in `.cloudflare.env`. This token is used only by the configuration helper and is never passed to the build.
4. Run:

   ```sh
   npm install
   npm run cloudflare:configure
   ```

   The helper updates the connected Worker's Workers Builds settings, sets the build and deploy commands, imports build variables from `.cloudflare.env`, and disables branch previews so preview branches cannot deploy against production resources.

5. Ensure both R2 buckets already exist in the same Cloudflare account:
   - `GALLERY_BUCKET`: the destination bucket for new Attic uploads.
   - `LEGACY_BUCKET`: the existing bucket containing older images. Do not create an empty replacement if this bucket already contains data.
6. Create a Cloudflare Secrets Store and add the secret **WORKERS_API_TOKEN**. Grant that token only the Cloudflare Access application permissions needed by the App Launcher feature. Put the Secrets Store ID in `SECRETS_STORE_ID`.
7. Ensure `PUBLIC_HOST` is a hostname on a zone in the same Cloudflare account. `PUBLIC_ORIGIN` must be its HTTPS origin. Keep the existing hostname and Worker Access policies in Cloudflare. Cloudflare authenticates requests before the Worker runs; Attic checks `ctx.access`, so the Workers deployment does not need team-domain or JWKS configuration. `CF_ACCESS_AUD` is optional: set it in `.cloudflare.env` if you want Attic to reject a native Access context whose audience differs from that value. Leave it blank to rely on the existing Cloudflare Access application and policies. Do not add an `access.dev` production setting.

The helper configures these Workers Builds settings:

- **Build command:** `npm run build:cloudflare`
- **Deploy command:** `npx wrangler deploy --config .cloudflare-build/wrangler.jsonc`
- **Preview builds:** disabled

On each production build, `tools/cloudflare-build.mjs` renders the account-specific configuration and builds `dist/worker.js` inside one staging transaction. A failed build leaves the previous rendered output untouched. Wrangler deploys the rendered config explicitly, not the placeholder template.

### What still requires Cloudflare resources

Wrangler configuration cannot create or populate the Secrets Store value, configure Cloudflare Access policies, or migrate existing R2 data. The two R2 buckets, custom domain/zone, existing Workers Access protection, and Secrets Store must exist before the first successful deployment. The helper does not create, rename or delete those resources.

### Local build and deploy

Use the same `.cloudflare.env` file:

```sh
npm install
npm test
npm run check
npm run deploy
```

The `.cloudflare.env` file is ignored by Git and excluded from rendered output. Never commit it. File-backed values such as `CLOUDFLARE_API_TOKEN=@secrets/api-token.txt` must reference a regular, non-symlink file relative to the `.cloudflare.env` directory; paths outside that directory are rejected.

## Development

```sh
npm test
npm run check
npm run dev
```

`npm run dev` performs the initial staged build, starts Wrangler, watches `src/`, `public/`, `tools/`, `build.mjs`, `wrangler.jsonc`, and `.cloudflare.env`, then rebuilds and restarts Wrangler after relevant changes, including changes to `.dev.vars`. The dev runner copies `.dev.vars` byte-for-byte beside the generated Wrangler config (and removes that private copy on shutdown), preserving Wrangler dotenv parsing. If `.dev.vars` does not define `LOCAL_DEV`, local development defaults it to `true`; set `LOCAL_DEV=false` in `.dev.vars` or the process environment to disable the local bypass. If a rebuild fails, the last successfully rendered output remains intact.

For self-hosted container operation, see `docker/entrypoint.sh`. `PUBLIC_URL` must be an HTTP(S) origin without credentials, path, query, or fragment. Container settings are persisted under `/data`. Password login is rate-limited per client using a SHA-256 fingerprint of Cloudflare’s `cf-connecting-ip` header and atomic conditional writes in the gallery R2 bucket (8 attempts per 15 minutes per client). Raw IP addresses are not stored in limiter keys. Its internal records live under `gallery/_system/` and are not public image paths.

The container's optional `AUTH_MODE=cloudflare-access` still uses its standalone JWT/JWKS validation and therefore requires `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`; this is separate from the Cloudflare Workers deployment. The Workers deployment can optionally pin its native Access context with `CF_ACCESS_AUD` without configuring JWKS.

Theme uploads and deletion are coordinated with short-lived, conditional R2 leases under `gallery/_system/theme-locks/`. This uses the existing R2 bucket and does not require a Durable Object, database, queue, or additional Cloudflare resource. ZIP imports are capped at 64 MiB total expanded image data, 12 MiB per image, and a 2048:1 maximum compression ratio.
