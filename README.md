# Attic

A private image archive for app icons and theme images. A Cloudflare Worker stores the images in R2 and sits behind Cloudflare Access; the front end is plain static files with no external libraries.

## Run it

```sh
npm test            # unit tests
npm run check       # syntax check of src/ and public/
node build.mjs      # bundle the Worker into dist/worker.js
```

To try it locally, copy `cloudflare.example.env`, fill in your own values and render a copy:

```sh
cp cloudflare.example.env my-values.env
node tools/render.mjs my-values.env build
(cd build && npx wrangler dev --local)
```

To deploy as your own, run `npx wrangler deploy --cwd build` on the rendered copy. All configuration is `__NAME__` placeholders in the tracked files; nothing environment-specific is committed.

`docker/entrypoint.sh` renders and serves the app from container environment variables, with data kept in `/data`.
