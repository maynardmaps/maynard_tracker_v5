# TODO

- [ ] Push to GitHub: run `git push` from a terminal (git is at
  `C:\Program Files\Git\cmd\git.exe`) and make sure Settings -> Pages is on
  (branch `main`, folder `/ (root)`). Site: https://maynardmaps.github.io/maynard_tracker_v5/
- [ ] Revoke the GitHub token that was pasted into the terminal, `.gitignore`
  and chat, and create a new fine-grained PAT (this repo only, Contents:
  read/write). Store it with `cd worker; wrangler.cmd secret put GITHUB_TOKEN`
  and enter the value at the prompt (never as a command argument). Until then
  "Save settings" only saves locally.
- [ ] Rotate the Met Office API key (it was printed in a chat session), then
  `cd worker; wrangler.cmd secret put METOFFICE_API_KEY`.
- [ ] In the OS Data Hub project, restrict the OS Maps key by HTTP referrer to
  `https://maynardmaps.github.io/*` (the key is committed in `js/secrets.js`).
- [ ] Change the config passphrase if it matters that it appeared in chat:
  `cd worker; wrangler.cmd secret put CONFIG_PASSPHRASE`.
- [x] (done: popups now show time, message, lat/lon, elevation, speed, course etc.) Enhanced Garmin KML pin popouts: decide what extra information to show
  (e.g. time, elevation, speed, course, battery, message text, device name)
  and extend the popup in `js/kml-markers.js`. Check what fields the feed
  actually provides (including the `ExtendedData` in the KML).
- [ ] Route upload from the configuration page: let the user pick a route
  folder and upload GPX/KML files from `config.html`. Extend the Worker
  (passphrase-gated, like `POST /settings`) to commit files to the fixed
  routes path in the repo, with filename/extension whitelisting and a size
  cap, then update the route manifest/settings so the map lists the new routes.

Done: Worker pins the Met Office order and caches weather; `ALLOWED_ORIGIN`
locked to `https://maynardmaps.github.io`; `secrets.js` now holds only the OS
key and is committed.
