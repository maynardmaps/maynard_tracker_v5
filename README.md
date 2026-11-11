# Maynard Tracker v5

A lightweight, static, client-only tracker map, designed to run on GitHub
Pages with **no backend**. It shows:

- An interactive Leaflet map (pan/zoom/geolocation/scale bar) with a choice
  of base layers: OpenStreetMap, Esri World Imagery (satellite), and Ordnance
  Survey Leisure (via the OS Maps API), plus the North Moor TT27 map.
- GPX/KML routes, loaded from subfolders under `routes/`, auto-coloured and
  individually toggleable; route-point labels can be toggled per route, and
  route points are not interactive.
- Live team positions and messages from two sources used together: Garmin IPC Outbound pushes (received by the Worker) and the MapShare KML feed. Position reports are compared by position timestamp; messages by message timestamp (not the timestamp of a later KML position update). Garmin popup headers and tracker information show a rounded relative age, with reports under one minute labeled "less than a minute ago". Position and message are separate markers; a message marker stays where the message was received (envelope, or a red pulsing SOS badge).
- Garmin position and message popups keep the team name, relative age, location, emergency state, and a clearly labeled “Nav to” link with a navigation-arrow icon visible; a dropdown expands to show the remaining tracker and message details, including coordinates to five decimal places.
- Garmin and river-level map icons older than the configurable 12-hour default are hidden, while configuration-page history remains available. In Test mode, the test tool can temporarily override the age filter to inspect older feed data.
- Optional tracker ETA is isolated in `js/eta.js`, disabled by default, and configured per tracker (route, direction and fallback speed). It matches positions to route geometry, estimates progress and speed from timestamped fixes, and marks a single invalid fix as low confidence before withholding ETA after repeated unusable matches. Lunch time/duration are configurable; offline local-arrival formatting is currently supported for UK routes.
- A Met Office precipitation radar/forecast overlay.
- A static "birds and rivers" KML overlay (points and polygons) loaded once
  from every KML file in the version-controlled `data/` folder.
- Environment Agency river level markers (arrows showing rising, falling or
  steady) for a configurable area of England, with the Dartmoor area as the default.
- A right-click / long-press menu giving the clicked coordinates, an OS grid
  reference (inside Great Britain) and a link to open the spot in a maps app.
- A nearby-item chooser for crowded taps: when multiple team, message, river,
  or birds-and-rivers markers are close together, choose the intended feature
  from a list; team, message, and river icons have larger invisible tap
  targets for mobile.
- Optional scheduled Gmail route-card import: authorized sender emails with
  Word attachments are validated, converted to KML, and added to a dated route
  folder for ETA use.
- A password-gated `config.html` page for editing defaults (start point,
  route colours, map sources, GitHub link) which are saved to
  `settings.json` and committed straight back to the repo via the GitHub
  Contents API, so every visitor picks up new defaults on next load.

The site is static files with no build step. A small Cloudflare Worker
(`worker/relay.js`) holds all secrets and does the server-side work: relaying
the Garmin KML and Met Office data, receiving Garmin IPC Outbound pushes,
sending Garmin IPC Inbound commands (messages, tracking start/stop), and
committing config changes to GitHub.

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
| Garmin IPC Outbound token | Worker secret `IPC_OUTBOUND_TOKEN` (required in every mode; must match the Authorization Token set in Garmin Portal Connect, sent in `X-Outbound-Auth-Token`) |
| Garmin IPC Inbound credentials (V1, HTTP Basic) | Worker secrets `IPC_INBOUND_USER` and `IPC_INBOUND_PASSWORD`; `IPC_SENDER` must be set to the sender's email address |
| Gmail route-card OAuth | Worker secrets `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, and `GMAIL_ALLOWED_SENDERS`; setup below |

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

## Importing route cards from Gmail

The Worker polls the inbox every five minutes for DOCX attachments from the
configured sender allowlist. It uses Gmail's read-only API scope and does not
mark messages read, change labels, or send email. Matching messages are limited
to the inbox and the most recent 30 days.

Each route card must include a `Route Card: <name>` title, a
`Summary @ <speed>kph` subtitle, and a waypoint table with `Leg`,
`Name / Position / Elevation`, `Bearing`, and `Distance` columns. Numbered
waypoints are converted from OS grid references to WGS84 and exported with
their names and elevations. Cards are rejected and logged to the Worker if
waypoint numbers are missing or duplicated, the bearing differs by more than 10
degrees, or the straight-line leg distance exceeds the listed distance by more
than 25 metres. Rejected attachments are not imported.

Successful cards are saved as `routes/YYYY-MM-DD/<route name>.kml`, with the
date determined in the `Europe/London` time zone. The date folder becomes the
default route folder. The card's speed is included as route metadata: it is
used to update fallback speeds for trackers already assigned to that route and
pre-fills the fallback-speed field when assigning a tracker to it later.
Duplicate route filenames in a daily folder are not overwritten. The importer
checks at most 10 messages and imports at most two valid cards per poll to stay
within Worker request limits; remaining work continues on later polls.

Setup (one time):

1. In Google Cloud Console, create a project, enable the Gmail API, configure
   the OAuth consent screen, and add the Gmail read-only scope
   `https://www.googleapis.com/auth/gmail.readonly`. Create an OAuth client ID
   of type **Desktop app** and download its JSON configuration.
2. Save that file locally as `tools/gmail-oauth-client.json` (it is ignored by
   git), then from the repository root run:

   ```powershell
   node tools/gmail-oauth-setup.mjs tools/gmail-oauth-client.json
   ```

   Open the printed Google authorization URL, sign in to the Gmail account to
   poll, and approve read-only access. The helper uses a temporary localhost
   callback and prints the resulting client ID, client secret, and refresh
   token. Keep those values private.
3. From `worker/`, enter each value at Wrangler's interactive prompt:

   ```powershell
   wrangler.cmd secret put GMAIL_CLIENT_ID
   wrangler.cmd secret put GMAIL_CLIENT_SECRET
   wrangler.cmd secret put GMAIL_REFRESH_TOKEN
   wrangler.cmd secret put GMAIL_ALLOWED_SENDERS
   wrangler.cmd deploy
   ```

   `GMAIL_ALLOWED_SENDERS` is a comma- or whitespace-separated list of exact
   sender email addresses. Never put OAuth values in a command argument or
   commit the downloaded client JSON. The Worker logs import/rejection results;
   use `wrangler.cmd tail` from `worker/` to inspect them. Google OAuth apps
   left in Testing mode can issue refresh tokens that expire after seven days;
   follow Google's publishing and verification requirements for ongoing use.

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

## Optional tracker ETA

Tracker ETA is disabled by default and isolated in `js/eta.js`. When enabled, assign a route, direction, and fallback speed to each tracker in **Expedition setup**. Imported route-card speeds appear as route defaults and prefill the fallback-speed field; existing assignments are updated when a card is imported. The **ETA management** section contains the feature toggle, stale-position threshold, and planned lunch time and duration. The compact team-position popup shows the destination-local time of day and time remaining, without a date; expanded details include the full arrival date and time. ETA uses cumulative route distance and time-stamped positions, smoothing the latest three valid speed intervals; a single off-route/ambiguous fix preserves the last estimate with a low-confidence warning, while repeated unusable matches or stale data make ETA unavailable. The test tool offers 10-minute sparse-ping simulation with an accelerated clock, as well as a faster 10-second demonstration. Simulated observation timestamps are separate from current receipt timestamps so test reports remain fresh while ETA speed calculations use the simulated travel interval. Destination-local arrival formatting is available for UK routes; outside the supported area the duration remains available and local time is reported unavailable.

To remove ETA if it proves unsuitable, remove the `js/eta.js` script includes from `index.html` and `config.html`, remove its map hooks from `js/map-page.js` and `js/kml-markers.js`, remove ETA controls/fields from `config.html` and `js/config-page.js`, and remove the `eta` and per-device ETA fields from `settings.json` and the Worker settings allowlist/validation in `worker/relay.js`. Remove `tools/test_eta.js` and the ETA-specific test controls from `test.html` and `js/test-page.js`. Garmin data ingestion, route rendering and messaging do not depend on the ETA module.

## Position Share

Website visitors can share their GPS location in real time using the map's **Position Share** menu option.
Position sharing is GPS-only (off if GPS is unavailable) and is individually configurable per visit.

**Using the feature:** Click **Position Share** in the map menu to enable sharing. A text box appears for a short identifier
(up to 4 characters, e.g. "A1", "Sue", "123"). Your display name persists in browser storage so the same identifier is used
if you re-enable sharing later. When enabled, your position is sent to the Worker immediately and then at a configurable
interval (default 5 minutes; range 1–60 minutes). Between updates, if "Show my location" is disabled, GPS is not actively
polled to preserve battery. Position sharing automatically stops after a configurable session duration (default 8 hours; range 1–24 hours).
You can manually disable sharing at any time; your marker disappears and no further positions are sent.

**Map display:** Shared positions appear as markers with the 4-letter name label, distinct from Garmin team markers (which
use diamonds). The map fetches positions every 10 seconds (same as Garmin positions) and updates their markers. Up to 24
concurrent sharers are supported.

**Configuration:** The **Position Share** section (config page, collapsed by default) has three settings:
- **Persistence**: How long shared positions remain on the server after upload (default 20 minutes; range 10–120 minutes).
  Positions automatically expire and disappear from the map when they age out.
- **Update rate**: How often positions are sent to the Worker (default 5 minutes; range 1–60 minutes).
- **Auto-stop**: How long a sharing session lasts before automatic stop (default 8 hours; range 1–24 hours).

**Backend:** Position sharing uses two Worker endpoints (no authentication required for public sharing):
- `POST /positions/share`: Accept a position update (latitude, longitude, timestamp, optional elevation, display name).
- `GET /positions`: Retrieve all active positions from KV.

Positions are stored in the Worker's KV with a TTL matching the persistence timeout, so they automatically expire.

## Configuration page

**Route management:** the config page lists the folders in `routes/` (scrollable) and lets you add/rename/delete folders and add/rename/delete GPX/KML files. Changes are committed to GitHub by the Worker (`POST /routes/manage`, passphrase-protected, needs the `GITHUB_TOKEN` secret). Empty folders are kept with a `.gitkeep`.

Visit `config.html` and enter the config passphrase. It is checked by the
Cloudflare Worker (stored there as the `CONFIG_PASSPHRASE` secret, never in
this repo), so it is real authorisation, not a client-side gate.

The configuration sections are ordered by workflow:

1. **Expedition setup:** default route folder, each tracker's route assignment, direction and fallback speed, plus the map start point and zoom.
2. **Messaging & tracking:** recent messages and tracking status, send text messages, and force start/stop/query tracking (see below).
3. **Map defaults:** available/default base maps, overlay defaults, river-level area, and the map icon age limit. The age limit (1–720 hours, default 12) hides old Garmin and river-level map icons only; older records remain in Location history.
4. **Map appearance:** generic 8-colour palettes for routes and Garmin markers.
5. **Diagnostics & test mode:** diagnostics panel toggle and Normal/Test operating mode.
6. **Location history:** recent position reports and messages, including raw event details; this is retained independently of the map icon age limit.
7. **Route management:** add, rename, and delete route folders/files.
8. **GitHub integration:** read-only owner, repository, and branch details.
9. **ETA management:** enable/disable ETA, stale-position threshold, and planned lunch time/duration. Per-tracker route assignments and fallback speeds are in Expedition setup.
10. **Device management:** add/edit/delete device names and 15-digit inReach IMEIs. These are kept separate from route assignments.

All sections are collapsible and initially closed. Settings are applied with **Save settings**, except route-management changes, which are committed immediately.

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

## Garmin direct API, operating modes and messaging

**Outbound (receiving).** In Garmin Portal Connect set the Outbound URL to
`https://<your-worker>.workers.dev/ipc/outbound` (HTTP POST JSON, event schema V2+) with a static
authorisation token equal to the Worker secret `IPC_OUTBOUND_TOKEN` (Garmin sends this in the
`X-Outbound-Auth-Token` header). The Worker also accepts `Authorization` for compatible clients. The Worker stores the latest
position, last 3 messages (free text, puck 1-3, SOS, SOS cancel) with their location, emergency state and
tracking state per registered IMEI in KV. The map reads `/ipc/locations` every 10 seconds
(`garminPushPollIntervalMs`) and the MapShare KML every minute (`garminPollIntervalMs`); for each team the newest
timestamp wins, per position and per message. Full Garmin settings are in the Note in `requirements.txt`.

**Modes** (config page, "Operating mode"). *Normal*: only authenticated Garmin traffic for registered
IMEIs is accepted. *Test*: unregistered IMEIs are also accepted, the test tool can inject false data, Inbound
commands are simulated (nothing is sent to Garmin or billed), and the map shows a red "TEST MODE" banner.
The token is required in both modes. Garmin Portal Connect's Outbound SOS Test is accepted in Test mode
for an unregistered fake IMEI; its test SOS at latitude 43, longitude -72 is exposed as an unregistered test
marker/message.

**Messaging tab** (config page, after unlocking). Shows each team's last 3 messages and tracking status, plus
an "Unregistered trackers" entry while Test mode data is present. Clear history, send text message, and force start / force stop / query tracking. Commands go through the
passphrase-protected `POST /ipc/command`, which calls Garmin IPC Inbound **V1**
(`https://eur-origin.explore.garmin.com:443/ipcinbound/V1`: `Messaging.svc/Message`, `Tracking.svc/Tracking`). Real
messages and tracking changes travel over Iridium and are billed to the device plan.

To check IPC Inbound authentication directly from a computer without involving the
Worker, run `python tools/test_garmin_inbound.py`. The script prompts for a 15-digit
IMEI, username, and hidden password, then issues only a read-only tracking-status
GET request to `https://eur-origin.explore.garmin.com:443/ipcinbound/V1/Tracking.svc/Tracking?IMEI=<IMEI>`
and prints Garmin's HTTP status and response. Credentials are not saved.

The Worker sends text messages to `POST /Messaging.svc/Message`. `IPC_SENDER` is
the sender email address. The request uses Garmin's `/Date(<Unix milliseconds>)/`
timestamp format, a string recipient IMEI, and the required `ReferencePoint`
fields used by the known-working Portal Connect example (`LocationType: "0"`,
altitude/speed/course `"1"`, coordinate `0,0`, and empty label). Tracking start
and stop use `POST /Tracking.svc/Tracking` with a numeric IMEI, boolean `Tracking`,
and interval in seconds; status uses `GET /Tracking.svc/Tracking?IMEI=<IMEI>`.

The unlocked config page's Messaging section also includes a passphrase-protected **command results log** (last 30
message/tracking commands), including the Garmin IPC Inbound endpoint, HTTP status, and bounded response body on failure.
This is the Worker-to-Garmin Inbound command log. It is separate from the test
tool's Garmin delivery log, which records Garmin-to-Worker **Outbound** deliveries.

The bottom of the unlocked config page also has **Location history**: up to five recent position reports or messages
per registered or unregistered tracker from Garmin IPC Outbound and MapShare KML, including source, event time,
reported coordinates, and raw event payload. KML reports are captured by the Worker when it relays the feed. It loads
when opened and can be refreshed on demand. The Garmin delivery log in the passphrase-protected test tool includes each request's
payload alongside its HTTP response; payloads are size-capped and marked when truncated, and auth header values are never logged.

**Test tool** (`test.html`, passphrase-protected, Test mode only for injection): inject any event type
with an age offset, a 20-step walk, route simulation (60 mph, configurable 10-minute ETA or 10-second demonstration reports, messages at turns, SOS at the
end), clear stored positions to test KML fallback, a messaging and tracking panel with failure simulation and
command log, and the Garmin delivery log (last 30 requests to `/ipc/outbound`).

## Cloudflare Worker relay (Garmin feed + Met Office weather)

Garmin's feed and the Met Office API send no CORS headers, and the Met Office
API needs an `apikey` header that free public proxies don't forward, so
browsers can't call either directly.
[worker/relay.js](worker/relay.js) is a tiny Cloudflare Worker with two
fixed-purpose routes (it is not an open proxy; the Garmin IPC and settings routes are described above):

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

Security notes: the Worker only allows CORS from the GitHub Pages origin, requires that Referer for OS tiles, validates every field of a saved `settings.json`, and requires the outbound token for all Garmin pushes, rate-limits wrong passphrases durably using the `RATE_LIMIT` KV namespace (5 failures per IP or 30 overall in 15 minutes locks out for 15 minutes). CDN scripts carry Subresource Integrity hashes; regenerate them if you change a library version.

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
config.html             Passphrase-gated configuration page (incl. Messaging)
test.html               Passphrase-gated test tool
css/styles.css          Shared responsive styles
js/
  app-config.js          Non-secret config (relay URL, poll intervals, GitHub defaults)
  utils.js               Shared helpers (fetch w/ timeout, colours)
  eta.js                 Optional route matching and tracker ETA calculations
  settings-store.js       Loads/merges/saves settings.json + localStorage override
  github-save.js          Commits settings.json via GitHub Contents API
  map-core.js             Leaflet map lifecycle + CRS switching
  routes.js               GPX/KML route loading, colouring, toggling
  kml-markers.js           Team position/message markers: push + KML merge, polling
  messaging-panel.js       Messaging and tracking panel (config page and test tool)
  test-page.js             test.html bootstrap (injection, route simulation, logs)
  birds-rivers.js          Static birds-and-rivers KML (points + polygons) loading/rendering
  river-levels.js          Environment Agency river level arrows
  weather.js               Met Office precipitation overlay
  geolocation.js           "Show my location" toggle
  map-page.js              index.html bootstrap
  config-page.js           config.html bootstrap
routes/
  manifest.json           Hand-maintained list of route folders/files
  TT1/, TT2/              Sample route files
maps/
  north-moor-tt27/        North Moor TT27 WebP XYZ tiles (z/x/y.webp)
  north-moor-tt27-epsg4326.tif
  north-moor-tt27-web-xyz.zip
  20261014-north-moor-map-tt27-o.pdf
data/
  birdsrivers.kml    Static points+polygons overlay (sample placeholder - replace with real data)
worker/
  relay.js                Cloudflare Worker (Garmin, Gmail route imports, Met Office, OS tiles, settings/routes writer)
  gmail-route-card.js     DOCX route-card parser, validation, OS grid conversion and KML generator
  wrangler.toml           Worker deploy config
  gmail-route-card.test.js  Route-card parser tests
  gmail-import.test.js      Scheduled Gmail import integration test
tools/
  gmail-oauth-setup.mjs   Local read-only Gmail OAuth setup helper
  test_eta.js             ETA regression tests
settings.json            Committed shared defaults (editable via config.html)
```

The North Moor TT27 tiles are selectable as the **North Moor TT27** base map.
The map uses the local `maps/north-moor-tt27/{z}/{x}/{y}.webp` tile set, with
native detail through zoom 16; the GeoTIFF, tile archive, and source GeoPDF
are kept alongside it in `maps/`.
