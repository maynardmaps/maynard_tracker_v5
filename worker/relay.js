// Cloudflare Worker with fixed-purpose endpoints (not an open proxy):
//   GET  /                        -> the Garmin MapShare KML feed
//   GET  /weather/latest[/<fileId>/data]
//                                 -> Met Office Map Images for ONE pinned
//                                    order (MET_ORDER_ID in wrangler.toml);
//                                    API key from the METOFFICE_API_KEY secret.
//   GET  /os/Leisure_27700/{z}/{x}/{y}.png
//                                 -> OS Maps tiles; key from OS_API_KEY secret.
//   POST /settings[/verify]       -> passphrase-protected settings.json commit.
const GARMIN_FEED = "https://share.garmin.com/Feed/Share/9ZU7V";
const MET_BASE = "https://data.hub.api.metoffice.gov.uk/map-images/1.0.0/orders";

// Browsers on other sites can't read responses. (Direct non-browser calls are
// still possible, which is why weather responses are cached below.)
const ALLOWED_ORIGIN = "https://maynardmaps.github.io";

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

const ID = "[A-Za-z0-9_+.\\-]+";
const WEATHER_PATH = new RegExp(`^/weather/latest(?:/(${ID})/data)?$`);
const WEATHER_CACHE_SECONDS = 300;

// Lists routes/<folder>/<file>.(gpx|kml) from the repo so new uploads appear
// without editing routes/manifest.json.
async function routesManifest(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache.invalid/routes-manifest");
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

  const headers = { "User-Agent": "maynard-relay", Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const upstream = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`, { headers });
  if (!upstream.ok) return new Response(`Upstream HTTP ${upstream.status}`, { status: 502, headers: CORS });
  const tree = (await upstream.json()).tree || [];
  const folders = {};
  for (const item of tree) {
    const m = /^routes\/([^/]+)\/([^/]+\.(?:gpx|kml))$/i.exec(item.path);
    if (item.type === "blob" && m) (folders[m[1]] = folders[m[1]] || []).push(m[2]);
  }
  Object.values(folders).forEach((a) => a.sort());
  const body = JSON.stringify({ folders });
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
  })));
  return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// OS Maps raster tiles: one whitelisted layer, key held as the OS_API_KEY secret.
const OS_TILE_PATH = /^\/os\/(Leisure_27700)\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/;
const OS_TILE_BASE = "https://api.os.uk/maps/raster/v1/zxy";

async function osTile(match, env, ctx, request) {
  if (!env.OS_API_KEY) return new Response("OS tiles not configured", { status: 500, headers: CORS });
  // Tile <img> requests send Referer rather than Origin; reject other sites.
  const referer = request.headers.get("Referer");
  if (referer && !referer.startsWith(ALLOWED_ORIGIN + "/")) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }
  const [, layer, z, x, y] = match;
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.invalid/os/${layer}/${z}/${x}/${y}`);
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: 200, headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });

  const upstream = await fetch(`${OS_TILE_BASE}/${layer}/${z}/${x}/${y}.png?key=${encodeURIComponent(env.OS_API_KEY)}`);
  if (!upstream.ok) return new Response(`Upstream HTTP ${upstream.status}`, { status: upstream.status === 404 ? 404 : 502, headers: CORS });
  const body = await upstream.arrayBuffer();
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }
  })));
  return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
}

async function garmin() {
  const upstream = await fetch(GARMIN_FEED, { cf: { cacheTtl: 0 } });
  if (!upstream.ok) return new Response(`Upstream HTTP ${upstream.status}`, { status: 502, headers: CORS });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function weather(match, env, ctx) {
  if (!env.METOFFICE_API_KEY || !env.MET_ORDER_ID) {
    return new Response("Weather not configured", { status: 500, headers: CORS });
  }
  const fileId = match[1];
  const base = `${MET_BASE}/${env.MET_ORDER_ID}/latest`;
  const target = fileId ? `${base}/${encodeURIComponent(fileId)}/data` : base;

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.invalid/weather?u=${encodeURIComponent(target)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: 200, headers: { ...CORS, "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream", "Cache-Control": "no-store" } });

  const upstream = await fetch(target, { headers: { apikey: env.METOFFICE_API_KEY } });
  if (!upstream.ok) {
    return new Response(`Upstream HTTP ${upstream.status}`, { status: 502, headers: CORS });
  }
  const type = upstream.headers.get("Content-Type") || "application/octet-stream";
  const body = await upstream.arrayBuffer();
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { "Content-Type": type, "Cache-Control": `public, max-age=${WEATHER_CACHE_SECONDS}` }
  })));
  return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": type, "Cache-Control": "no-store" } });
}

// ---- Settings writer -------------------------------------------------
// The GitHub token and passphrase live only in Worker secrets
// (GITHUB_TOKEN, CONFIG_PASSPHRASE). The only thing this can ever write is
// settings.json in the fixed repo below.
const GH_OWNER = "maynardmaps";
const GH_REPO = "maynard_tracker_v5";
const GH_BRANCH = "main";
const GH_PATH = "settings.json";
const MAX_SETTINGS_BYTES = 50000;
const ALLOWED_KEYS = new Set([
  "_comment", "github", "defaultRouteFolder", "startPoint", "startZoom",
  "mapSources", "routeColours", "kmlMarkerColour", "weatherEnabledByDefault",
  "birdsRiversEnabledByDefault"
]);

let failedAttempts = 0;
let lockedUntil = 0;

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function passphraseOk(request, env) {
  if (!env.CONFIG_PASSPHRASE) return false;
  if (Date.now() < lockedUntil) return false;
  const [a, b] = await Promise.all([
    digest(request.headers.get("X-Config-Passphrase") || ""),
    digest(env.CONFIG_PASSPHRASE)
  ]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff === 0) {
    failedAttempts = 0;
    return true;
  }
  // Best-effort brute-force slowdown (per isolate): lock out after 5 misses.
  if (++failedAttempts >= 5) {
    lockedUntil = Date.now() + 60000;
    failedAttempts = 0;
  }
  await new Promise((r) => setTimeout(r, 1000));
  return false;
}

function validSettings(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (!Object.keys(s).every((k) => ALLOWED_KEYS.has(k))) return false;
  const p = s.startPoint;
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
  if (!Number.isFinite(s.startZoom)) return false;
  if (typeof s.defaultRouteFolder !== "string") return false;
  if (!Array.isArray(s.mapSources)) return false;
  return s.mapSources.every((m) => m && typeof m.id === "string" && typeof m.url === "string" &&
    /^https:\/\//.test(m.url));
}

function toBase64Utf8(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function saveSettings(request, env) {
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN secret not set" }, 500);
  const raw = await request.text();
  if (raw.length > MAX_SETTINGS_BYTES) return json({ error: "Too large" }, 413);
  let settings;
  try { settings = JSON.parse(raw); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  if (!validSettings(settings)) return json({ error: "Invalid settings" }, 400);
  settings.github = { owner: GH_OWNER, repo: GH_REPO, branch: GH_BRANCH };

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "maynard-relay"
  };
  let sha;
  const get = await fetch(`${url}?ref=${GH_BRANCH}`, { headers });
  if (get.ok) sha = (await get.json()).sha;
  else if (get.status !== 404) return json({ error: `GitHub read failed (${get.status})` }, 502);

  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Update settings.json via config page",
      content: toBase64Utf8(JSON.stringify(settings, null, 2) + "\n"),
      sha,
      branch: GH_BRANCH
    })
  });
  if (!put.ok) return json({ error: `GitHub commit failed (${put.status})` }, 502);
  return json({ ok: true }, 200);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && (pathname === "/settings" || pathname === "/settings/verify")) {
      try {
        if (!(await passphraseOk(request, env))) return json({ error: "Unauthorized" }, 401);
        if (pathname === "/settings/verify") return json({ ok: true }, 200);
        return await saveSettings(request, env);
      } catch (e) {
        return json({ error: "Server error" }, 500);
      }
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    try {
      if (pathname === "/") return await garmin();
      if (pathname === "/routes") return await routesManifest(env, ctx);
      const osMatch = OS_TILE_PATH.exec(pathname);
      if (osMatch) return await osTile(osMatch, env, ctx, request);
      const match = WEATHER_PATH.exec(pathname);
      if (match) return await weather(match, env, ctx);
      return new Response("Not found", { status: 404, headers: CORS });
    } catch (e) {
      return new Response("Upstream fetch failed", { status: 502, headers: CORS });
    }
  }
};
