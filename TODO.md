# TODO

- [ ] Push to GitHub: create an empty public repo `maynardmaps/maynard_tracker_v5`,
  run `git push -u origin main` from a terminal (git is at
  `C:\Program Files\Git\cmd\git.exe`), then enable Settings -> Pages (branch
  `main`, folder `/ (root)`). Site: https://maynardmaps.github.io/maynard_tracker_v5/
- [ ] Revoke the GitHub token that was pasted into the terminal, `.gitignore`
  and chat, and create a new fine-grained PAT (this repo only, Contents:
  read/write). Store it with `cd worker; wrangler.cmd secret put GITHUB_TOKEN`
  and enter the value at the prompt (never as a command argument). Until then
  "Save settings" only saves locally. Do not put it in `secrets.js`.
- [ ] Supply the browser-safe values to the live site: `js/secrets.js` is
  gitignored, so the deployed site has no OS Maps key or `metOfficeOrderId`
  (OS Leisure and weather stay off). Options: commit a trimmed copy holding
  only those two values (no Met Office or GitHub keys), and restrict the OS
  key by referrer in the OS portal.
- [ ] Remove API keys from the deployed `js/secrets.js`: blank `metOfficeApiKey`
  now that the Cloudflare Worker holds it as the `METOFFICE_API_KEY` secret
  (keep `metOfficeOrderId`, which isn't secret). Re-check the weather overlay
  still renders afterwards.
- [ ] Set `ALLOWED_ORIGIN` in `worker/relay.js` to `https://maynardmaps.github.io`
  instead of `"*"`, then redeploy with `cd worker; wrangler.cmd deploy`. This
  stops other sites using the Met Office quota. Note it will block
  `http://localhost:8080` testing.
- [ ] Change the config passphrase if it matters that it appeared in chat:
  `cd worker; wrangler.cmd secret put CONFIG_PASSPHRASE`.
- [ ] Enhanced Garmin KML pin popouts: decide what extra information to show
  (e.g. time, elevation, speed, course, battery, message text, device name)
  and extend the popup in `js/kml-markers.js`. Check what fields the feed
  actually provides (including the `ExtendedData` in the KML).
