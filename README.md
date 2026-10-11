# Maynard Tracker v5

A lightweight, static, client-only tracker map, designed to run on GitHub
Pages with **no backend**. It shows:

- An interactive Leaflet map (pan/zoom/geolocation/scale bar) with a choice
  of base layers: OpenStreetMap, Esri World Imagery (satellite), and Ordnance
  Survey Leisure (via the OS Maps API).
- GPX/KML routes, loaded from subfolders under `routes/`, auto-coloured and
  individually toggleable.
- Live Garmin MapShare markers (polled KML feed).
- A Met Office precipitation radar/forecast overlay.
- A static "birds and rivers" KML overlay (points and polygons) loaded once
  from every KML file in the version-controlled `data/` folder.
- Environment Agency river level markers (arrows showing rising, falling or
  steady) for a configurable area of England, with the Dartmoor area as the default.
- A right-click / long-press menu giving the clicked coordinates, an OS grid
  reference (inside Great Britain) and a link to open the spot in a maps app.
- A password-gated `config.html` page for editing defaults (start point,
  route colours, map sources, GitHub link) which are saved to
  `settings.json` and committed straight back to the repo via the GitHub
  Contents API, so every visitor picks up new defaults on next load.

Everything runs from static files - there is no server-side code, no build
step, and no required write access except the optional "Save to GitHub"
button on the config page.

## Quick start (local)

No build tools are required. Just serve the folder over HTTP (file:// won't
work because of `fetch`/CORS restrictions):

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080/index.html`.

## Secrets and keys

Nothing sensitive is in this repo:

| Item | Where it lives |
|---|---|
| OS Maps key | Worker secret `OS_API_KEY`; tiles are fetched through the Worker (`/os/Leisure_27700/{z}/{x}/{y}.png`), which also rejects other sites by Referer and caches tiles. `cd worker; wrangler.cmd secret put OS_API_KEY`. |
| Met Office API key | Worker secret `METOFFICE_API_KEY` |
| Met Office order id | Worker var `MET_ORDER_ID` in `worker/wrangler.toml` |
| GitHub token (fine-grained PAT, this repo only, Contents: read/write) | Worker secret `GITHUB_TOKEN` |
| Config page passphrase | Worker secret `CONFIG_PASSPHRASE` |

Set Worker secrets with `wrangler.cmd secret put <NAME>` and type the value at
the prompt (never as a command argument).

## Deploying to GitHub Pages

1. Push this repository to GitHub (`maynardmaps/maynard_tracker_v5`).
2. In the repo settings, enable **GitHub Pages** for `main`, root folder.
3. Deploy the Worker (see below) and set `ALLOWED_ORIGIN` in `worker/relay.js`
   to the Pages origin (`https://maynardmaps.github.io`). Local testing from
   `http://localhost:8080` is then blocked by CORS; temporarily set it to
   `"*"` (or your localhost origin) and redeploy if you need to test.
## Adding/updating routes

Routes live under `routes/<folder>/<file>.gpx|.kml`. On every page load the
site asks the Worker (`GET /routes`, cached 60s) for a live listing of that
folder from GitHub, so new folders/files appear in the dropdown automatically.
`routes/manifest.json` is only an offline fallback used if the Worker is
unreachable; update it by hand if you want the fallback to stay current:

```json
{
  "folders": [
    { "name": "TT1", "files": ["sample-route-a.gpx", "sample-route-b.gpx"] },
    { "name": "TT2", "files": ["sample-route.kml"] }
  ]
}
```

Colours come from two generic 8-colour palettes set on the config page (one for routes, one for Garmin markers). The Nth route/marker in alphanumerical order takes colour N;
the palette repeats when there are more than 8.

## Birds and rivers overlay

Every `.kml` file in the `data/` folder is loaded (the Worker lists the folder, like routes) and
shown together as one togglable "Birds and rivers" overlay, off by default. Files can contain
`Point` (e.g. bird sightings) and `Polygon` (e.g. rivers, wetlands) placemarks. They are loaded once
per page load (not polled) by `js/birds-rivers.js`. Points and polygons get a fixed style, and clicking
a feature shows its name and description. The shipped `birdsrivers.kml` is placeholder sample data.

## River levels overlay

`js/river-levels.js` shows Environment Agency river level stations (free open data, no key) as small
arrows: up for rising, down for falling, right for steady, coloured by how the level compares to the
station's typical range. It is separate from the birds and rivers overlay, off by default, and refreshes
every 15 minutes. The area is a box set on the config page (default: around Dartmoor; "Whole of England"
is available).

## Configuration page

**Route management:** the config page lists the folders in `routes/` (scrollable) and lets you add/rename/delete folders and add/rename/delete GPX/KML files. Changes are committed to GitHub by the Worker (`POST /routes/manage`, passphrase-protected, needs the `GITHUB_TOKEN` secret). Empty folders are kept with a `.gitkeep`.

Visit `config.html` and enter the config passphrase. It is checked by the
Cloudflare Worker (stored there as the `CONFIG_PASSPHRASE` secret, never in
this repo), so it is real authorisation, not a client-side gate.

From there you can set:

- Default route folder shown on load.
- Map start point/zoom (type coordinates or click/drag the picker map).
- Route colours: a generic palette of 8 colours.
- Garmin KML marker colours: a generic palette of 8 colours.
- Whether the weather overlay is on by default.
- Whether the birds and rivers overlay is on by default.
- River levels: on by default, and the area box to display.
- Which base map sources are offered, their display names/URLs, and you can
  add your own XYZ tile sources.
- The GitHub owner/repo/branch (read-only; fixed in the Worker).

Clicking **Save settings** saves to `localStorage` immediately and asks the
Worker to commit `settings.json` to GitHub. The GitHub token is a Worker
secret (`GITHUB_TOKEN`), so it never reaches the browser, and the Worker can
only write a validated `settings.json` in this repo. One-time setup:

```
cd worker
wrangler.cmd secret put GITHUB_TOKEN        # fine-grained PAT, this repo only, Contents: read/write
wrangler.cmd secret put CONFIG_PASSPHRASE   # the config page passphrase
wrangler.cmd deploy
```

## Cloudflare Worker relay (Garmin feed + Met Office weather)

Garmin's feed and the Met Office API send no CORS headers, and the Met Office
API needs an `apikey` header that free public proxies don't forward, so
browsers can't call either directly.
[worker/relay.js](worker/relay.js) is a tiny Cloudflare Worker with two
fixed-purpose routes (it is not an open proxy):

- `/` - the one hard-coded Garmin feed, with CORS headers added.
- `/weather/latest[/<fileId>/data]` - the Met Office Map Images API for the one order pinned in `MET_ORDER_ID`,
  with the API key added server-side from a Worker secret, so the key never
  needs to be shipped to the browser.


Deploy (free tier, no card needed; on Windows PowerShell use `wrangler.cmd`
if scripts are blocked):

1. `npm install -g wrangler` then `wrangler login`
2. `cd worker`, then store the Met Office key: `wrangler secret put METOFFICE_API_KEY`
3. `wrangler deploy`
4. Copy the printed `https://maynard-garmin-relay.<you>.workers.dev` URL into
   `garminRelayUrl` in `js/app-config.js` (used for both routes), commit and push.

Also set the Met Office order id in `MET_ORDER_ID` in `worker/wrangler.toml`.
Weather responses are cached in the Worker for 5 minutes.

The site depends on the relay for the Garmin feed; there are no third-party proxy fallbacks. If the Garmin share ID changes, update `GARMIN_FEED` in the worker.

Security notes: the Worker only allows CORS from the GitHub Pages origin, requires that Referer for OS tiles, validates every field of a saved `settings.json`, and rate-limits wrong passphrases durably using the `RATE_LIMIT` KV namespace (5 failures per IP or 30 overall in 15 minutes locks out for 15 minutes). CDN scripts carry Subresource Integrity hashes; regenerate them if you change a library version.

## Known limitations / operational notes

- **Single point of dependency.** The Garmin feed, Met Office weather and OS tiles all go through the Cloudflare Worker. If it is down or over its free quota, those layers stop updating.
- **OS Leisure zoom range.** The OS Maps API `Leisure_27700` layer only
  serves zoom levels 0-9 (confirmed empirically - zoom 10+ returns HTTP
  400). The map correctly disables further zoom-in at that point; this is
  expected, not a bug.
- **OS Leisure CRS switching.** `Leisure_27700` is published in British
  National Grid (EPSG:27700), incompatible with the Web Mercator
  (EPSG:3857) used by OSM/Esri. Selecting it destroys and recreates the
  Leaflet map with the matching CRS (preserving view/center), and all
  overlays re-attach automatically. This is intentional and was tested
  working end-to-end, including with routes correctly reprojected.
- **Met Office overlay bounding box.** The Map Images API doesn't expose
  per-image geographic bounds, so `metOfficeUkBounds` in
  `js/app-config.js` is a best-effort UK bounding box calibrated against the
  image's aspect ratio. If the radar/forecast overlay looks offset from the
  base map, adjust those four values.
- **"Save to GitHub" needs the Worker's `GITHUB_TOKEN` secret.** Without it,
  Save succeeds locally (`localStorage`) but reports that GitHub was not
  updated, so other visitors won't see the change.

## Project structure

```
index.html              Map page
config.html             Passphrase-gated configuration page
css/styles.css          Shared responsive styles
js/
  app-config.js          Non-secret config (relay URL, poll intervals, GitHub defaults)
  utils.js               Shared helpers (fetch w/ timeout, colours)
  settings-store.js       Loads/merges/saves settings.json + localStorage override
  github-save.js          Commits settings.json via GitHub Contents API
  map-core.js             Leaflet map lifecycle + CRS switching
  routes.js               GPX/KML route loading, colouring, toggling
  kml-markers.js           Garmin KML feed polling/rendering
  birds-rivers.js          Static birds-and-rivers KML (points + polygons) loading/rendering
  river-levels.js          Environment Agency river level arrows
  weather.js               Met Office precipitation overlay
  geolocation.js           "Show my location" toggle
  map-page.js              index.html bootstrap
  config-page.js           config.html bootstrap
routes/
  manifest.json           Hand-maintained list of route folders/files
  TT1/, TT2/              Sample route files
data/
  birdsrivers.kml    Static points+polygons overlay (sample placeholder - replace with real data)
worker/
  relay.js                Cloudflare Worker relay (Garmin feed + Met Office weather)
  wrangler.toml           Worker deploy config
settings.json            Committed shared defaults (editable via config.html)
```
