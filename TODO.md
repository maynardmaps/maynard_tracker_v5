# TODO

- [ ] Create a fine-grained GitHub PAT (this repo only, Contents: read/write)
  and run `cd worker; wrangler.cmd secret put GITHUB_TOKEN`. Until then
  "Save settings" only saves locally. Do not put it in `secrets.js`.
- [ ] Remove API keys from the deployed `js/secrets.js`: blank `metOfficeApiKey`
  now that the Cloudflare Worker holds it as the `METOFFICE_API_KEY` secret
  (keep `metOfficeOrderId`, which isn't secret). Re-check the weather overlay
  still renders afterwards.
- [ ] Set `ALLOWED_ORIGIN` in `worker/relay.js` to the page origin (the GitHub
  Pages origin, e.g. `https://<user>.github.io`) instead of `"*"`, then
  redeploy with `cd worker; wrangler.cmd deploy`. This stops other sites using
  the Met Office quota. Note it will block `http://localhost:8080` testing.
