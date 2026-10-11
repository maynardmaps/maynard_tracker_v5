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
  "Access-Control-Allow-Headers": "Content-Type, X-Config-Passphrase"
};

const ID = "[A-Za-z0-9_+.\\-]+";
const WEATHER_PATH = new RegExp(`^/weather/latest(?:/(${ID})/data)?$`);
const WEATHER_CACHE_SECONDS = 300;

const KEEP_FILE = ".gitkeep"; // placeholder so an empty folder exists in git
const ROUTES_CACHE_KEY = "https://cache.invalid/routes-manifest";

// Lists routes/<folder>/<file>.(gpx|kml) from the repo so new uploads appear
// without editing routes/manifest.json.
async function routesManifest(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(ROUTES_CACHE_KEY);
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

  const headers = { "User-Agent": "maynard-relay", Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const upstream = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`, { headers });
  if (!upstream.ok) return new Response(`Upstream HTTP ${upstream.status}`, { status: 502, headers: CORS });
  const tree = (await upstream.json()).tree || [];
  const folders = {};
  const data = [];
  for (const item of tree) {
    const d = /^data\/([^/]+\.kml)$/i.exec(item.path);
    if (item.type === "blob" && d) data.push(d[1]);
    const m = /^routes\/([^/]+)\/([^/]+)$/.exec(item.path);
    if (item.type !== "blob" || !m) continue;
    if (m[2] === KEEP_FILE) folders[m[1]] = folders[m[1]] || [];
    else if (/\.(?:gpx|kml)$/i.test(m[2])) (folders[m[1]] = folders[m[1]] || []).push(m[2]);
  }
  Object.values(folders).forEach((a) => a.sort());
  data.sort();
  const body = JSON.stringify({ folders, data });
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
  if (!referer || !referer.startsWith(ALLOWED_ORIGIN + "/")) {
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
  "mapSources", "routeColours", "markerColours", "weatherEnabledByDefault",
  "birdsRiversEnabledByDefault", "diagnosticsEnabled", "riverLevels"
]);

// Fallback used only if the RATE_LIMIT KV binding is missing.
let failedAttempts = 0;
let lockedUntil = 0;

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// Durable brute-force protection (KV, shared across all Worker instances):
// 5 wrong passphrases from one IP in 15 minutes locks that IP out for 15
// minutes; 30 wrong passphrases from anywhere locks everyone out the same way.
const RL_WINDOW_S = 900;
const RL_IP_MAX = 5;
const RL_GLOBAL_MAX = 30;

async function rlRead(env, key) {
  try { return (await env.RATE_LIMIT.get(key, "json")) || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; }
}

async function rlBump(env, key, max) {
  const cur = await rlRead(env, key);
  cur.n += 1;
  if (cur.n >= max) { cur.until = Date.now() + RL_WINDOW_S * 1000; cur.n = 0; }
  try { await env.RATE_LIMIT.put(key, JSON.stringify(cur), { expirationTtl: RL_WINDOW_S }); } catch (e) { /* best effort */ }
}

async function passphraseOk(request, env) {
  if (!env.CONFIG_PASSPHRASE) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = `fail:ip:${ip}`;
  const globalKey = "fail:global";
  if (env.RATE_LIMIT) {
    const [i, g] = await Promise.all([rlRead(env, ipKey), rlRead(env, globalKey)]);
    if (Date.now() < i.until || Date.now() < g.until) return false;
  } else if (Date.now() < lockedUntil) {
    return false;
  }
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
  if (env.RATE_LIMIT) {
    await Promise.all([rlBump(env, ipKey, RL_IP_MAX), rlBump(env, globalKey, RL_GLOBAL_MAX)]);
  } else if (++failedAttempts >= 5) {
    lockedUntil = Date.now() + 60000;
    failedAttempts = 0;
  }
  await new Promise((r) => setTimeout(r, 1000));
  return false;
}
const MAP_SOURCE_KEYS = new Set(["id", "name", "url", "attribution", "type", "requiresKey", "enabled"]);
const OS_PREFIX = "https://api.os.uk/maps/raster/v1/zxy/";
const isBool = (v) => typeof v === "boolean";
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

function mapSourceError(m, i, ids) {
  const at = `mapSources[${i}]`;
  if (!m || typeof m !== "object" || Array.isArray(m)) return `${at} invalid`;
  if (!Object.keys(m).every((k) => MAP_SOURCE_KEYS.has(k))) return `${at} has unknown fields`;
  if (typeof m.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(m.id)) return `${at}.id invalid`;
  if (ids.has(m.id)) return `${at}.id duplicated`;
  ids.add(m.id);
  if (m.name !== undefined && !isStr(m.name, 200)) return `${at}.name invalid`;
  if (m.attribution !== undefined && !isStr(m.attribution, 200)) return `${at}.attribution invalid`;
  if (m.type !== undefined && m.type !== "xyz" && m.type !== "os-27700") return `${at}.type invalid`;
  if (m.enabled !== undefined && !isBool(m.enabled)) return `${at}.enabled invalid`;
  if (m.requiresKey !== undefined && !isBool(m.requiresKey)) return `${at}.requiresKey invalid`;
  if (!isStr(m.url, 300) || !/^https:\/\//.test(m.url)) return `${at}.url must be https (max 300 chars)`;
  for (const ph of ["{z}", "{x}", "{y}"]) {
    if (!m.url.includes(ph)) return `${at}.url must contain ${ph}`;
  }
  let u;
  try { u = new URL(m.url.replace(/\{[xyzs]\}/g, "0")); } catch (e) { return `${at}.url is not a valid URL`; }
  if (u.username || u.password) return `${at}.url must not contain credentials`;
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":")) {
    return `${at}.url must use a public host name`;
  }
  if (m.requiresKey && !m.url.startsWith(OS_PREFIX)) return `${at}.requiresKey is only allowed for Ordnance Survey URLs`;
  return null;
}

// Returns a short reason string if the settings are invalid, otherwise null.
function settingsError(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "Settings must be an object";
  const bad = Object.keys(s).find((k) => !ALLOWED_KEYS.has(k));
  if (bad) return `Unknown setting "${bad}"`;
  if (s._comment !== undefined && !isStr(s._comment, 500)) return "_comment invalid";
  const p = s.startPoint;
  if (!p || !inRange(p.lat, -90, 90) || !inRange(p.lng, -180, 180)) return "startPoint invalid";
  if (!Number.isInteger(s.startZoom) || s.startZoom < 1 || s.startZoom > 19) return "startZoom must be 1-19";
  if (typeof s.defaultRouteFolder !== "string" || (s.defaultRouteFolder && !FOLDER_RE.test(s.defaultRouteFolder))) {
    return "defaultRouteFolder invalid";
  }
  for (const k of ["weatherEnabledByDefault", "birdsRiversEnabledByDefault", "diagnosticsEnabled"]) {
    if (s[k] !== undefined && !isBool(s[k])) return `${k} must be true or false`;
  }
  for (const k of ["routeColours", "markerColours"]) {
    if (s[k] !== undefined && !(Array.isArray(s[k]) && s[k].length <= 8 &&
        s[k].every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)))) return `${k} invalid`;
  }
  const rl = s.riverLevels;
  if (rl !== undefined) {
    if (!rl || typeof rl !== "object" || Array.isArray(rl)) return "riverLevels invalid";
    if (!Object.keys(rl).every((k) => k === "enabledByDefault" || k === "bounds")) return "riverLevels has unknown fields";
    if (rl.enabledByDefault !== undefined && !isBool(rl.enabledByDefault)) return "riverLevels.enabledByDefault invalid";
    const b = rl.bounds;
    if (b !== undefined) {
      if (!b || !inRange(b.south, 49, 61) || !inRange(b.north, 49, 61) || !inRange(b.west, -9, 3) ||
          !inRange(b.east, -9, 3) || b.south >= b.north || b.west >= b.east) return "riverLevels.bounds invalid";
    }
  }
  if (!Array.isArray(s.mapSources) || s.mapSources.length > 12) return "mapSources must be a list of at most 12";
  const ids = new Set();
  for (let i = 0; i < s.mapSources.length; i++) {
    const err = mapSourceError(s.mapSources[i], i, ids);
    if (err) return err;
  }
  return null;
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
  const settingsProblem = settingsError(settings);
  if (settingsProblem) return json({ error: `Invalid settings: ${settingsProblem}` }, 400);
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


// ---- Route management ------------------------------------------------
// Folder/file add, rename and delete under routes/, each applied as one
// atomic commit via the git data API. Passphrase-protected like /settings.
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 _().\-]{0,79}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 _().\-]{0,79}\.(?:gpx|kml)$/i;
const MAX_UPLOAD_B64 = 2000000; // ~1.5 MB of file data
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(env, path, init) {
  const res = await fetch(GH_API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "maynard-relay",
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) throw new HttpError(502, `GitHub ${path.split("?")[0]} failed (${res.status})`);
  return res.json();
}

async function manageRoutes(request, env, ctx) {
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN secret not set" }, 500);
  const raw = await request.text();
  if (raw.length > MAX_UPLOAD_B64 + 2000) return json({ error: "Too large" }, 413);
  let req;
  try { req = JSON.parse(raw); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  try {
    await applyRouteOp(req, env);
    await caches.default.delete(new Request(ROUTES_CACHE_KEY));
    return json({ ok: true }, 200);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    throw e;
  }
}

function checkName(re, value, what) {
  if (typeof value !== "string" || !re.test(value)) throw new HttpError(400, `Invalid ${what} name`);
  return value;
}

async function applyRouteOp(req, env) {
  const ref = await gh(env, `/git/ref/heads/${GH_BRANCH}`);
  const headSha = ref.object.sha;
  const head = await gh(env, `/git/commits/${headSha}`);
  const tree = (await gh(env, `/git/trees/${head.tree.sha}?recursive=1`)).tree;
  const blobs = tree.filter((i) => i.type === "blob" && i.path.startsWith("routes/"));
  const inFolder = (f) => blobs.filter((i) => i.path.startsWith(`routes/${f}/`));
  const exists = (path) => blobs.some((i) => i.path === path);

  const changes = []; // { path, sha | null, mode, content? }
  const del = (item) => changes.push({ path: item.path, mode: item.mode, type: "blob", sha: null });
  const move = (item, path) => { del(item); changes.push({ path, mode: item.mode, type: "blob", sha: item.sha }); };
  const keepEntry = (folder) => ({ path: `routes/${folder}/${KEEP_FILE}`, mode: "100644", type: "blob", content: "\n" });
  let message;

  switch (req.op) {
    case "addFolder": {
      const f = checkName(FOLDER_RE, req.folder, "folder");
      if (inFolder(f).length) throw new HttpError(409, "Folder already exists");
      changes.push(keepEntry(f));
      message = `Add route folder ${f}`;
      break;
    }
    case "renameFolder": {
      const f = checkName(FOLDER_RE, req.folder, "folder");
      const to = checkName(FOLDER_RE, req.to, "new folder");
      const items = inFolder(f);
      if (!items.length) throw new HttpError(404, "Folder not found");
      if (inFolder(to).length) throw new HttpError(409, "A folder with that name already exists");
      items.forEach((i) => move(i, `routes/${to}/${i.path.slice(`routes/${f}/`.length)}`));
      message = `Rename route folder ${f} to ${to}`;
      break;
    }
    case "deleteFolder": {
      const f = checkName(FOLDER_RE, req.folder, "folder");
      const items = inFolder(f);
      if (!items.length) throw new HttpError(404, "Folder not found");
      items.forEach(del);
      message = `Delete route folder ${f}`;
      break;
    }
    case "addFile": {
      const f = checkName(FOLDER_RE, req.folder, "folder");
      const name = checkName(FILE_RE, req.name, "file");
      if (!inFolder(f).length) throw new HttpError(404, "Folder not found");
      if (exists(`routes/${f}/${name}`)) throw new HttpError(409, "A file with that name already exists");
      if (typeof req.contentBase64 !== "string" || !req.contentBase64 || req.contentBase64.length > MAX_UPLOAD_B64 ||
          !/^[A-Za-z0-9+/=\r\n]+$/.test(req.contentBase64)) throw new HttpError(400, "Invalid file content");
      const blob = await gh(env, "/git/blobs", {
        method: "POST", body: JSON.stringify({ content: req.contentBase64, encoding: "base64" })
      });
      changes.push({ path: `routes/${f}/${name}`, mode: "100644", type: "blob", sha: blob.sha });
      message = `Add route file ${f}/${name}`;
      break;
    }
    case "renameFile": {
      const f = checkName(FOLDER_RE, req.folder, "folder");
      const name = checkName(FILE_RE, req.name, "file");
      const to = checkName(FILE_RE, req.to, "new file");
      const item = blobs.find((i) => i.path === `routes/${f}/${name}`);
      if (!item) throw new HttpError(404, "File not found");
      if (exists(`routes/${f}/${to}`)) throw new HttpError(409, "A file with that name already exists");
      move(item, `routes/${f}/${to}`);
      message = `Rename route file ${f}/${name} to ${to}`;
      break;
    }
    case "deleteFile": {
      const f = checkName(FOLDER_RE, req.folder, "folder");
      const name = checkName(FILE_RE, req.name, "file");
      const item = blobs.find((i) => i.path === `routes/${f}/${name}`);
      if (!item) throw new HttpError(404, "File not found");
      del(item);
      // Keep the folder in git if this was its last file.
      const remaining = inFolder(f).filter((i) => i !== item);
      if (!remaining.length) changes.push(keepEntry(f));
      message = `Delete route file ${f}/${name}`;
      break;
    }
    default:
      throw new HttpError(400, "Unknown operation");
  }

  const newTree = await gh(env, "/git/trees", {
    method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree: changes })
  });
  const commit = await gh(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: `${message} via config page`, tree: newTree.sha, parents: [headSha] })
  });
  await gh(env, `/git/refs/heads/${GH_BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
}
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && (pathname === "/settings" || pathname === "/settings/verify" || pathname === "/routes/manage")) {
      try {
        if (!(await passphraseOk(request, env))) return json({ error: "Unauthorized" }, 401);
        if (pathname === "/settings/verify") return json({ ok: true }, 200);
        if (pathname === "/routes/manage") return await manageRoutes(request, env, ctx);
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
