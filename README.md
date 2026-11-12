# Attic

A private image archive for app icons and theme images. A Cloudflare Worker stores the images in R2 and sits behind Cloudflare Access; the front end is plain static files with no external libraries.

Nothing environment-specific is committed: the tracked files hold only `__NAME__` placeholders, and your own values stay in a file git ignores, in GitHub Actions secrets or in Cloudflare build variables.

## Run your own copy

There are four ways, and they all end in the same app. Pick one.

| Way | You need | Runs on |
|---|---|---|
| [Docker](#docker) | Docker | Your own machine or server |
| [From your computer](#from-your-computer) | Node.js 24, a Cloudflare account | Cloudflare |
| [GitHub Actions](#github-actions) | A GitHub account, a Cloudflare account | Cloudflare, on every push to `main` |
| [Cloudflare Workers Builds](#cloudflare-workers-builds) | A GitHub or GitLab account, a Cloudflare account | Cloudflare, on every push to `main` |

A GitHub account is only needed for the last two. For the first two, download the source as a ZIP file or clone it.

### Docker

```sh
ADMIN_PASSWORD='choose-a-long-password' docker compose up -d
```

Open <http://localhost:8787> and sign in with the password. Images are kept in the `data` volume. To serve it under another address, set `PUBLIC_URL` as well, for example `PUBLIC_URL=https://images.example.com`. Instead of typing the values on the command line you can put them in a file named `.env` next to `compose.yaml`; git ignores it.

The port is published on this machine only. To reach the app from other machines, put a reverse proxy with HTTPS in front of it; `BIND_ADDRESS=0.0.0.0` publishes the port on every network interface without encryption, so use that on a trusted network only. Use Docker Engine 28.3.3 or later; older versions let other hosts on the same network reach ports published on 127.0.0.1.

### Your values on Cloudflare

The three Cloudflare ways use the same values. They are listed in `cloudflare.example.env`:

| Name | Value |
|---|---|
| `PUBLIC_HOST` | The host name the archive is served on, for example `images.example.com`. The domain must be in your Cloudflare account. |
| `PUBLIC_ORIGIN` | The same address with the scheme, for example `https://images.example.com`. |
| `GALLERY_BUCKET` | Name of the R2 bucket for the archive. |
| `LEGACY_BUCKET` | Name of an R2 bucket with older images to copy from. It may be an empty bucket. |
| `CF_ACCESS_TEAM_DOMAIN` | Your Cloudflare Access team domain, for example `your-team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | The Application Audience (AUD) tag of the Access application that protects `PUBLIC_HOST`. Nobody can sign in without it, so `tools/deploy.sh` refuses to deploy while it is empty. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID. |
| `SECRETS_STORE_ID` | Optional; leave it empty (`SECRETS_STORE_ID=`) if you have none, and the binding is left out. ID of a Secrets Store that holds a secret named `WORKERS_API_TOKEN` (an API token with Access: Apps: Edit). Only the "Använd i App Launcher" button needs it. |

Do this once in the Cloudflare dashboard, before the first deploy:

1. Create the two R2 buckets.
2. Under Zero Trust, add a self-hosted Access application for `PUBLIC_HOST` with a policy that lets you in, and copy its AUD tag.
3. Create an API token for deploying, from the "Edit Cloudflare Workers" template. It is the value of `CLOUDFLARE_API_TOKEN` below. Add the permission Account: Secrets Store: Edit if you use `SECRETS_STORE_ID`.

### From your computer

```sh
cp cloudflare.example.env .cloudflare.env
```

Fill in `.cloudflare.env` (git ignores every `*.env` file except the example), sign in once and deploy:

```sh
npx wrangler login
```

```sh
sh tools/deploy.sh .cloudflare.env
```

Run the last command again whenever you want to deploy a newer version. `tools/deploy.sh` fills the values into a temporary copy, deploys it and removes it. Extra arguments go to `wrangler deploy`; `sh tools/deploy.sh .cloudflare.env --dry-run` builds without uploading. If `.cloudflare.env` also has the lines `CLOUDFLARE_API_TOKEN=...` and `CLOUDFLARE_ACCOUNT_ID=...`, they are used and `wrangler login` is not needed; if either of the two is already exported in your shell, that value wins over the file.

### GitHub Actions

Fork the repo, or push a copy to your own account. Fill in `.cloudflare.env` as above and add a line `CLOUDFLARE_API_TOKEN=...` with the API token. Then store every value as a repository secret with the [GitHub CLI](https://cli.github.com/):

```sh
grep -v '=$' .cloudflare.env | gh secret set -f - -R your-account/attic
```

The same can be done by hand under Settings → Secrets and variables → Actions. From then on the Deploy workflow deploys every push to `main`, and it can be started by hand under Actions → Deploy → Run workflow. The values are never written to a file in the repo and GitHub masks them in the logs. Without the secret `CLOUDFLARE_API_TOKEN` the workflow does nothing.

### Cloudflare Workers Builds

In the Cloudflare dashboard, create a Worker named `attic` from your repository (Workers & Pages → Create → Import a repository) and set:

- Deploy command: `sh tools/deploy.sh`
- Build variables and secrets: every name from the table above with your value
- Settings → Build → Branch control: turn off Enable Preview Builds
- API token: if you use `SECRETS_STORE_ID`, select the token you created above; the token Cloudflare creates by itself cannot bind Secrets Store secrets

Cloudflare then deploys every push to `main`. Use either this or the GitHub Actions way, not both, or each push is deployed twice.

## Develop

```sh
npm test            # unit tests
npm run check       # syntax check of src/ and public/
node build.mjs      # bundle the Worker into dist/worker.js
```

To try it locally without Docker, render a copy with your values and start it:

```sh
node tools/render.mjs .cloudflare.env build
```

```sh
(cd build && npx wrangler dev --local)
```
