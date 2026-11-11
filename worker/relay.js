// Cloudflare Worker with fixed-purpose endpoints (not an open proxy):
//   GET  /                        -> the Garmin MapShare KML feed
//   GET  /weather/latest[/<fileId>/data]
//                                 -> Met Office Map Images for ONE pinned
//                                    order (MET_ORDER_ID in wrangler.toml);
//                                    API key from the METOFFICE_API_KEY secret.
//   GET  /os/Leisure_27700/{z}/{x}/{y}.png
//                                 -> OS Maps tiles; key from OS_API_KEY secret.
//   POST /ipc/outbound            -> Garmin IPC Outbound receiver. Normal mode needs the
//                                    IPC_OUTBOUND_TOKEN secret (Authorization header)
//                                    and registered IMEIs only; test mode (settings
//                                    "mode") also accepts unregistered IMEIs.
//   GET  /ipc/locations?imeis=a,b -> latest stored position per device.
//   POST /settings[/verify]       -> passphrase-protected settings.json commit.
import { parseRouteCard, routeCardToKml } from "./gmail-route-card.js";

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
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_IMPORT_PREFIX = "gmail-route-import:";
const GMAIL_IMPORT_TTL_SECONDS = 60 * 60 * 24 * 365;
const MAX_GMAIL_DOCX_BYTES = 8 * 1024 * 1024;
const MAX_GMAIL_MESSAGES_PER_POLL = 10;
const MAX_GMAIL_CARDS_PER_POLL = 2;

const POSITION_SHARE_MAX_USERS = 24;
const POSITION_SHARE_PREFIX = "position-share:";
const POSITION_SHARE_DEFAULT_PERSISTENCE_MINUTES = 20;
const POSITION_SHARE_DEFAULT_UPDATE_MINUTES = 5;
const POSITION_SHARE_DEFAULT_AUTO_STOP_HOURS = 8;

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

// Workers don't expose DOMParser; extract the point placemarks needed by the
// protected history from Garmin's KML response without changing the map feed.
function xmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, "").trim();
}

function kmlTag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<(?:(?:[\\w.-]+):)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${escaped}\\s*>`, "i").exec(block);
  return match ? xmlText(match[1]) : "";
}

function kmlProperties(block) {
  const properties = {};
  const data = /<Data\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/Data\s*>/gi;
  const simple = /<SimpleData\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/SimpleData\s*>/gi;
  let match;
  while ((match = data.exec(block))) properties[xmlText(match[1])] = kmlTag(match[2], "value");
  while ((match = simple.exec(block))) properties[xmlText(match[1])] = xmlText(match[2]);
  return properties;
}

function kmlTime(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec(String(value || "").trim());
  if (match) {
    let hours = Number(match[4]) % 12;
    if (/^P/i.test(match[7] || "")) hours += 12;
    else if (!match[7]) hours = Number(match[4]);
    return Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]), hours, Number(match[5]), Number(match[6]));
  }
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

function kmlHistoryRecords(kml, cfg, fetchedAt) {
  const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
  const byImei = new Map(devices.map((device) => [String(device.imei), device]));
  const byName = new Map(devices.map((device) => [String(device.name || "").trim().toLowerCase(), device]));
  const records = [];
  const placemarks = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark\s*>/gi;
  let match;
  while ((match = placemarks.exec(kml))) {
    const block = match[1];
    const point = /<Point\b[^>]*>([\s\S]*?)<\/Point\s*>/i.exec(block);
    if (!point) continue;
    const coordinate = kmlTag(point[1], "coordinates").split(/[,\s]+/).map(Number);
    if (coordinate.length < 2 || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ||
        Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) continue;
    const properties = kmlProperties(block);
    const name = kmlTag(block, "name") || properties.Name || "";
    const rawImei = String(properties.IMEI || properties.Imei || properties.Id || "").trim();
    const device = /^\d{15}$/.test(rawImei) ? byImei.get(rawImei) : byName.get(name.trim().toLowerCase());
    const imei = device ? String(device.imei) : rawImei;
    if (!/^\d{15}$/.test(imei)) continue;
    const positionTimestamp = kmlTime(properties["Time UTC"] || properties.Time || kmlTag(block, "when"));
    const positionTime = positionTimestamp === null ? fetchedAt : positionTimestamp;
    const messageTime = kmlTime(properties["Message Time"]);
    const text = String(properties.Text || "").trim().slice(0, 500);
    const raw = JSON.stringify({ source: "MapShare KML", name, properties, coordinates: [coordinate[0], coordinate[1]] });
    const entry = (kind, time, id) => ({
      time, latitude: coordinate[1], longitude: coordinate[0], kind, source: "MapShare KML", id,
      raw: raw.length > IPC_EVENT_PAYLOAD_MAX ? raw.slice(0, IPC_EVENT_PAYLOAD_MAX) : raw,
      truncated: raw.length > IPC_EVENT_PAYLOAD_MAX
    });
    const positionId = positionTimestamp === null
      ? `position|${name}|${coordinate[0]}|${coordinate[1]}`
      : `position|${positionTimestamp}|${coordinate[0]}|${coordinate[1]}`;
    records.push({ imei, entry: entry("position", positionTime, positionId) });
    if (text) {
      const eventTime = messageTime === null ? positionTime : messageTime;
      const messageId = messageTime === null
        ? `message|${name}|${coordinate[0]}|${coordinate[1]}|${text}`
        : `message|${messageTime}|${text}`;
      records.push({ imei, entry: entry(properties["Message Type"] || "message", eventTime, messageId) });
    }
  }
  return records;
}

async function recordKmlHistory(kml, env, cfg, fetchedAt) {
  if (!env.RATE_LIMIT) return;
  const records = kmlHistoryRecords(kml, cfg, fetchedAt);
  if (!records.length) return;
  const state = (await env.RATE_LIMIT.get(IPC_STATE_KEY, "json")) || {};
  let changed = false;
  records.forEach(({ imei, entry }) => {
    const rec = state[imei] || {};
    const ids = rec.kmlHistoryIds || [];
    if (ids.includes(entry.id)) return;
    if (!state[imei] && Object.keys(state).length >= IPC_MAX_DEVICES) return;
    rec.kmlHistoryIds = ids.concat(entry.id).slice(-200);
    rec.locationHistory = (rec.locationHistory || []).concat([entry])
      .sort((a, b) => b.time - a.time).slice(0, IPC_LOCATION_HISTORY_MAX);
    state[imei] = rec;
    changed = true;
  });
  if (changed) await env.RATE_LIMIT.put(IPC_STATE_KEY, JSON.stringify(state));
}

async function garmin(env) {
  const upstream = await fetch(GARMIN_FEED, { cf: { cacheTtl: 0 } });
  if (!upstream.ok) return new Response(`Upstream HTTP ${upstream.status}`, { status: 502, headers: CORS });
  const kml = await upstream.text();
  try {
    await recordKmlHistory(kml, env, await ipcConfig(env), Date.now());
  } catch (e) {
    console.error("Could not record Garmin KML history", e);
  }
  return new Response(kml, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// Garmin IPC Outbound receiver: Garmin POSTs events here; the latest state per
// device is kept in a single KV entry and served by GET /ipc/locations.
const IPC_STATE_KEY = "ipc:state";
const IPC_MAX_BODY = 2000000;
const IPC_MAX_DEVICES = 50;
const IPC_EMERGENCY_ON = new Set([4, 6]);
const IPC_HISTORY_MAX = 3;
const IPC_LOCATION_HISTORY_MAX = 5;
const IPC_LOG_PAYLOAD_MAX = 12000;
const IPC_EVENT_PAYLOAD_MAX = 12000;
const IPC_INBOUND_RESPONSE_MAX = 2000;
const IPC_INBOUND_BASE = "https://eur-origin.explore.garmin.com:443/ipcinbound/V1";
const IPC_CMD_LOG_KEY = "ipc:cmdlog";

function ipcTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function safeEqual(a, b) {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

// Operating mode and registered IMEIs. Written to KV whenever settings are saved;
// until then they are read from the committed settings.json.
const CFG_KEY = "cfg:ipc";

function ipcConfigFrom(s) {
  const ps = (s && s.positionShare) || {};
  return {
    mode: s && s.mode === "test" ? "test" : "normal",
    gmailRouteImportEnabled: !s || s.gmailRouteImportEnabled !== false,
    positionSharePersistenceMinutes: ps.persistenceMinutes || POSITION_SHARE_DEFAULT_PERSISTENCE_MINUTES,
    positionShareUpdateMinutes: ps.updateMinutes || POSITION_SHARE_DEFAULT_UPDATE_MINUTES,
    positionShareAutoStopHours: ps.autoStopHours || POSITION_SHARE_DEFAULT_AUTO_STOP_HOURS,
    imeis: ((s && s.devices) || []).map((d) => d.imei).filter((i) => /^\d{15}$/.test(i)),
    devices: ((s && s.devices) || []).filter((d) => d && /^\d{15}$/.test(d.imei)).map((d) => ({ imei: d.imei, name: d.name }))
  };
}

async function ipcConfig(env) {
  try {
    const kv = await env.RATE_LIMIT.get(CFG_KEY, "json");
    if (kv && Array.isArray(kv.imeis) && Array.isArray(kv.devices)) return kv;
    if (kv && Array.isArray(kv.imeis)) {
      const res = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_PATH}`, { cf: { cacheTtl: 60 } });
      if (res.ok) {
        const fromSettings = ipcConfigFrom(await res.json());
        return { ...fromSettings, mode: kv.mode || fromSettings.mode, imeis: kv.imeis };
      }
      return { ...kv, devices: [] };
    }
  } catch (e) { /* fall through */ }
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_PATH}`, { cf: { cacheTtl: 60 } });
    if (res.ok) return ipcConfigFrom(await res.json());
  } catch (e) { /* fall through */ }
  return { mode: "normal", imeis: [] };
}

// Normal mode: only authenticated Garmin traffic for registered IMEIs is accepted.
// Test mode: unregistered IMEIs are accepted too (token always required).
async function ipcReceive(request, env) {
  if (!env.RATE_LIMIT) return json({ error: "IPC not configured" }, 503);
  const cfg = await ipcConfig(env);
  const testMode = cfg.mode === "test";
  if (!env.IPC_OUTBOUND_TOKEN) return json({ error: "IPC token not configured" }, 503);
  {
    // Garmin Portal Connect sends its configured token under this header name.
    // Keep Authorization support for compatible clients and existing setups.
    const given = (request.headers.get("X-Outbound-Auth-Token") || request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!given || !(await safeEqual(given, env.IPC_OUTBOUND_TOKEN.replace(/^Bearer\s+/i, "")))) {
      return json({ error: "Unauthorized" }, 401);
    }
  }
  if (!/^application\/json/i.test(request.headers.get("Content-Type") || "")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  const text = await request.text();
  if (text.length > IPC_MAX_BODY) return json({ error: "Too large" }, 413);
  let payload;
  try { payload = JSON.parse(text); } catch (e) { return json({ error: "Invalid JSON" }, 400); }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.Events)) {
    return json({ error: "Not a Garmin IPC Outbound payload" }, 400);
  }
  await ipcApply(payload.Events, env, cfg, testMode);
  return json({ ok: true }, 200);
}

const IPC_PUCK = {
  14: { type: "ok", text: "All ok" },
  15: { type: "assist", text: "We're ok, but assistance needed" },
  16: { type: "urgent", text: "Urgent Assistance required" }
};

// Maps an event to the "last message" shown on the map, or null if it carries none.
function ipcMessage(code, freeText) {
  const free = typeof freeText === "string" ? freeText.trim().slice(0, 500) : "";
  if (code === 3 && free) return { type: "text", text: free };
  if (IPC_PUCK[code]) return IPC_PUCK[code];
  if (IPC_EMERGENCY_ON.has(code)) return { type: "sos", text: free };
  if (code === 7) return { type: "sos-cancelled", text: free };
  return null;
}

async function ipcApply(events, env, cfg, testMode) {
  const registered = new Set(cfg.imeis);
  let state = (await env.RATE_LIMIT.get(IPC_STATE_KEY, "json")) || {};
  let changed = false;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const code = Number(ev.messageCode);
    const parsedTs = ipcTimestamp(ev.timeStamp);
    const ts = parsedTs === null && testMode ? Date.now() : parsedTs;
    const simulationTs = testMode ? ipcTimestamp(ev.simulationTimeStamp) : null;
    const p = ev.point || {};
    const st = ev.status || {};
    for (const imei of String(ev.imei || "").split(",").map((s) => s.trim())) {
      if (!/^\d{15}$/.test(imei)) continue;
      if (!testMode && !registered.has(imei)) continue;
      if (!state[imei] && Object.keys(state).length >= IPC_MAX_DEVICES) continue;
      const rec = state[imei] || {};
      const hasFix = Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && (p.latitude !== 0 || p.longitude !== 0) &&
        inRange(p.latitude, -90, 90) && inRange(p.longitude, -180, 180);
      if (hasFix && Number.isFinite(ts) && ts >= (rec.timestamp || 0)) {
        rec.timestamp = ts;
        rec.latitude = p.latitude;
        rec.longitude = p.longitude;
        rec.altitude = Number.isFinite(p.altitude) ? p.altitude : null;
        rec.speed = Number.isFinite(p.speed) ? p.speed : null;
        rec.course = Number.isFinite(p.course) ? p.course : null;
        rec.gpsFix = Number.isFinite(p.gpsFix) ? p.gpsFix : null;
        if (Number.isFinite(simulationTs) && simulationTs > 0) rec.simulationTimestamp = simulationTs;
        else delete rec.simulationTimestamp;
      }
      if (st.lowBattery === 0 || st.lowBattery === 1) rec.lowBattery = st.lowBattery === 1;
      if (IPC_EMERGENCY_ON.has(code)) rec.inEmergency = true;
      else if (code === 7) rec.inEmergency = false;
      const msg = ipcMessage(code, ev.freeText);
      const msgPos = hasFix
        ? { latitude: p.latitude, longitude: p.longitude, altitude: Number.isFinite(p.altitude) ? p.altitude : null, speed: Number.isFinite(p.speed) ? p.speed : null, course: Number.isFinite(p.course) ? p.course : null }
        : (Number.isFinite(rec.latitude) ? { latitude: rec.latitude, longitude: rec.longitude, altitude: rec.altitude, speed: rec.speed, course: rec.course } : null);
      if (hasFix || msg) {
        const raw = JSON.stringify(ev);
        rec.locationHistory = (rec.locationHistory || []).concat([{
          time: Number.isFinite(ts) ? ts : Date.now(),
          latitude: hasFix ? p.latitude : null,
          longitude: hasFix ? p.longitude : null,
          kind: msg ? msg.type : "position",
          source: testMode ? "Test injection" : "Garmin push",
          raw: raw.length > IPC_EVENT_PAYLOAD_MAX ? raw.slice(0, IPC_EVENT_PAYLOAD_MAX) : raw,
          truncated: raw.length > IPC_EVENT_PAYLOAD_MAX
        }]).sort((a, b) => b.time - a.time).slice(0, IPC_LOCATION_HISTORY_MAX);
      }
      if (msg) {
        const at = Number.isFinite(ts) ? ts : Date.now();
        rec.history = (rec.history || []).filter((h) => !(h.time === at && h.type === msg.type && h.text === msg.text));
        rec.history.push({ type: msg.type, text: msg.text, time: at, pos: msgPos });
        rec.history.sort((a, b) => b.time - a.time);
        rec.history = rec.history.slice(0, IPC_HISTORY_MAX);
      }
      if (code === 10 || code === 11) rec.tracking = { active: true, time: Date.now(), source: "event" };
      else if (code === 12) rec.tracking = { active: false, time: Date.now(), source: "event" };
      if (msg && (!rec.msgTime || !Number.isFinite(ts) || ts >= rec.msgTime)) {
        rec.msgType = msg.type;
        rec.text = msg.text;
        rec.textTime = Number.isFinite(ts) ? ts : Date.now();
        rec.msgTime = rec.textTime;
        rec.msgPos = msgPos;
      }
      rec.updated = Date.now();
      state[imei] = rec;
      changed = true;
    }
  }
  if (changed) await env.RATE_LIMIT.put(IPC_STATE_KEY, JSON.stringify(state));
  return changed;
}

// Rolling log of the last requests to /ipc/outbound (no secrets: header names only),
// readable from the test page to diagnose Garmin delivery problems.
const IPC_LOG_KEY = "ipc:log";
const IPC_LOG_MAX = 30;

async function ipcLog(env, request, res) {
  if (!env.RATE_LIMIT) return;
  let reason = "";
  if (res.status !== 200) { try { reason = (await res.clone().json()).error || ""; } catch (e) { /* none */ } }
  const raw = await request.text();
  const log = (await env.RATE_LIMIT.get(IPC_LOG_KEY, "json")) || [];
  log.unshift({
    time: new Date().toISOString(), status: res.status, reason,
    contentType: request.headers.get("Content-Type") || "",
    headers: [...request.headers.keys()].filter((h) => !h.startsWith("cf-") && !h.startsWith("x-forwarded")).slice(0, 20),
    payload: raw.slice(0, IPC_LOG_PAYLOAD_MAX),
    payloadTruncated: raw.length > IPC_LOG_PAYLOAD_MAX
  });
  await env.RATE_LIMIT.put(IPC_LOG_KEY, JSON.stringify(log.slice(0, IPC_LOG_MAX)));
}

// Passphrase-protected remote commands (messaging tab and test tool).
// Normal mode sends the real Garmin IPC Inbound V1 call (HTTP Basic auth with the Portal Connect credentials in the IPC_INBOUND_USER and IPC_INBOUND_PASSWORD
// secret; messages are billed to the device plan). Test mode never contacts
// Garmin: the command is simulated, recorded in the command log, and applied to
// the stored state so the whole flow can be exercised at no cost.
async function ipcCmdLog(env, entry) {
  const log = (await env.RATE_LIMIT.get(IPC_CMD_LOG_KEY, "json")) || [];
  log.unshift({ time: new Date().toISOString(), ...entry });
  await env.RATE_LIMIT.put(IPC_CMD_LOG_KEY, JSON.stringify(log.slice(0, IPC_LOG_MAX)));
}

async function garminInbound(env, method, path, body) {
  const res = await fetch(IPC_INBOUND_BASE + path, {
    method,
    headers: { Authorization: "Basic " + btoa(env.IPC_INBOUND_USER + ":" + env.IPC_INBOUND_PASSWORD), "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const responseText = await res.text();
  let data = null;
  try { data = responseText ? JSON.parse(responseText) : null; } catch (e) { /* non-JSON response */ }
  if (!res.ok) {
    const responseDetail = String((data && (data.message || data.description)) || responseText.trim());
    const err = new Error(`Garmin HTTP ${res.status}${responseDetail ? `: ${responseDetail.slice(0, 1000)}` : ""}`);
    err.status = res.status;
    err.upstreamStatus = res.status;
    err.upstreamEndpoint = `${method} ${path}`;
    err.upstreamContentType = res.headers.get("Content-Type") || "";
    err.upstreamResponse = responseText.slice(0, IPC_INBOUND_RESPONSE_MAX);
    err.upstreamResponseTruncated = responseText.length > IPC_INBOUND_RESPONSE_MAX;
    throw err;
  }
  return data;
}

async function ipcCommand(request, env) {
  if (!env.RATE_LIMIT) return json({ error: "IPC not configured" }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON" }, 400); }
  const action = body && body.action;
  const cfg = await ipcConfig(env);
  const testMode = cfg.mode === "test";
  const state = (await env.RATE_LIMIT.get(IPC_STATE_KEY, "json")) || {};

  if (action === "locationHistory") {
    const registered = cfg.imeis.map((imei) => ({
      imei,
      entries: (state[imei] && state[imei].locationHistory) || []
    }));
    const registeredSet = new Set(cfg.imeis);
    const unregistered = Object.keys(state)
      .filter((imei) => /^\d{15}$/.test(imei) && !registeredSet.has(imei))
      .map((imei) => ({ imei, name: "Unregistered tracker", entries: state[imei].locationHistory || [] }));
    return json({ registered, unregistered }, 200);
  }

  if (action === "cmdLog") return json({ log: (await env.RATE_LIMIT.get(IPC_CMD_LOG_KEY, "json")) || [] }, 200);
  if (action === "clearCmdLog") { await env.RATE_LIMIT.delete(IPC_CMD_LOG_KEY); return json({ ok: true }, 200); }

  const imei = String((body && body.imei) || "");
  if (!/^\d{15}$/.test(imei)) return json({ error: "imei must be 15 digits" }, 400);
  if (!testMode && !cfg.imeis.includes(imei)) return json({ error: "IMEI is not a registered device" }, 400);

  if (action === "clearHistory") {
    const rec = state[imei] || {};
    rec.clearedAt = Date.now();
    rec.history = [];
    state[imei] = rec;
    await env.RATE_LIMIT.put(IPC_STATE_KEY, JSON.stringify(state));
    return json({ ok: true }, 200);
  }

  const known = ["sendMessage", "trackingStart", "trackingStop", "trackingStatus"];
  if (!known.includes(action)) return json({ error: "Unknown action" }, 400);

  let text = "", interval = 0;
  if (action === "sendMessage") {
    text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 160) return json({ error: "Message must be 1-160 characters" }, 400);
  }
  if (action === "trackingStart") {
    interval = Number(body.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440) return json({ error: "interval must be a whole number from 1 to 1440" }, 400);
  }

  const entry = { action, imei, mode: testMode ? "test (simulated)" : "normal (Garmin)", text };
  try {
    let result = { ok: true };
    if (testMode) {
      if (body.simulateFailure === true) throw Object.assign(new Error("Simulated Garmin failure"), { status: 422 });
    } else {
      if (!env.IPC_INBOUND_USER || !env.IPC_INBOUND_PASSWORD) throw Object.assign(new Error("IPC_INBOUND_USER / IPC_INBOUND_PASSWORD secrets are not set on the Worker"), { status: 503 });
      if (action === "sendMessage") {
        const sender = String(env.IPC_SENDER || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
          throw Object.assign(new Error("IPC_SENDER must be set to a valid sender email address"), { status: 503 });
        }
        result = await garminInbound(env, "POST", "/Messaging.svc/Message", {
          Messages: [{
            Recipients: [imei],
            Sender: sender,
            Timestamp: `/Date(${Date.now()})/`,
            Message: text,
            ReferencePoint: {
              LocationType: "0",
              Altitude: "1",
              Speed: "1",
              Course: "1",
              Coordinate: { Latitude: 0, Longitude: 0 },
              Label: ""
            }
          }]
        });
      } else if (action === "trackingStart" || action === "trackingStop") {
        await garminInbound(env, "POST", "/Tracking.svc/Tracking", {
          Devices: [{ IMEI: Number(imei), Tracking: action === "trackingStart", Interval: action === "trackingStart" ? interval * 60 : 0 }]
        });
      } else {
        const g = await garminInbound(env, "GET", "/Tracking.svc/Tracking?IMEI=" + imei);
        const d = g && Array.isArray(g.Devices) ? g.Devices.find((x) => String(x.IMEI) === imei) : null;
        if (!d) throw Object.assign(new Error("Garmin returned no tracking status for this device"), { status: 502 });
        const rec = state[imei] || {};
        rec.tracking = { active: d.Tracking === true, interval: d.Interval ? Math.round(d.Interval / 60) : null, time: Date.now(), source: "garmin" };
        state[imei] = rec;
        await env.RATE_LIMIT.put(IPC_STATE_KEY, JSON.stringify(state));
      }
    }
    if (action === "trackingStart" || action === "trackingStop") {
      const rec = state[imei] || {};
      rec.tracking = { active: action === "trackingStart", interval: action === "trackingStart" ? interval : null, time: Date.now(), source: testMode ? "simulated" : "command" };
      state[imei] = rec;
      await env.RATE_LIMIT.put(IPC_STATE_KEY, JSON.stringify(state));
      result.tracking = rec.tracking;
    }
    if (action === "trackingStatus") result.tracking = (state[imei] && state[imei].tracking) || null;
    await ipcCmdLog(env, { ...entry, ok: true });
    return json(result, 200);
  } catch (e) {
    const upstream = e.upstreamStatus ? {
      upstreamStatus: e.upstreamStatus,
      upstreamEndpoint: e.upstreamEndpoint,
      upstreamContentType: e.upstreamContentType,
      upstreamResponse: e.upstreamResponse,
      upstreamResponseTruncated: e.upstreamResponseTruncated
    } : {};
    await ipcCmdLog(env, { ...entry, ok: false, error: e.message, ...upstream });
    return json({ error: e.message, ...upstream }, e.status === 401 || e.status === 403 ? 502 : (e.status && e.status < 600 ? e.status : 502));
  }
}

// Passphrase-protected test tool; injection only works while mode is "test".
async function ipcTest(request, env) {
  if (!env.RATE_LIMIT) return json({ error: "IPC not configured" }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON" }, 400); }
  const action = body && body.action;
  if (action === "log") return json({ log: (await env.RATE_LIMIT.get(IPC_LOG_KEY, "json")) || [] }, 200);
  if (action === "clearLog") { await env.RATE_LIMIT.delete(IPC_LOG_KEY); return json({ ok: true }, 200); }
  const cfg = await ipcConfig(env);
  if (cfg.mode !== "test") return json({ error: "Server is in normal mode. Set Test mode on the config page and save." }, 403);
  if (action === "clear") { await env.RATE_LIMIT.delete(IPC_STATE_KEY); return json({ ok: true }, 200); }
  if (action === "inject") {
    if (!Array.isArray(body.events) || body.events.length > 100) return json({ error: "events must be an array (max 100)" }, 400);
    const changed = await ipcApply(body.events, env, cfg, true);
    return json({ ok: true, stored: changed }, 200);
  }
  return json({ error: "Unknown action" }, 400);
}

async function ipcLocations(url, env) {
  if (!env.RATE_LIMIT) return json({ error: "IPC not configured" }, 503);
  const cfg = await ipcConfig(env);
  const state = (await env.RATE_LIMIT.get(IPC_STATE_KEY, "json")) || {};
  const param = url.searchParams.get("imeis");
  let imeis = param ? param.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(state);
  if (cfg.mode !== "test") imeis = imeis.filter((i) => cfg.imeis.includes(i));
  if (!imeis.length || imeis.length > IPC_MAX_DEVICES || !imeis.every((i) => /^\d{15}$/.test(i))) {
    return json(param ? { error: "imeis must be comma-separated 15-digit IMEIs" } : { locations: [] }, param ? 400 : 200);
  }
  const locations = imeis.filter((i) => state[i] && (state[i].timestamp || state[i].history || state[i].tracking || state[i].locationHistory)).map((i) => {
    const r = state[i];
    const hasMessage = (r.msgTime || 0) > (r.clearedAt || 0);
    return {
      imei: i,
      timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      simulationTimestamp: cfg.mode === "test" && Number.isFinite(r.simulationTimestamp) ? r.simulationTimestamp : null,
      coordinate: r.timestamp ? { latitude: r.latitude, longitude: r.longitude } : null,
      altitude: r.altitude, speed: r.speed, course: r.course, gpsFixStatus: r.gpsFix,
      lowBattery: r.lowBattery === true, inEmergency: r.inEmergency === true,
      text: hasMessage ? (r.text || "") : null,
      textTime: r.textTime || null,
      messagePosition: hasMessage ? (r.msgPos || null) : null,
      messageType: hasMessage ? (r.msgType || "text") : null,
      clearedAt: r.clearedAt || 0,
      history: (r.history || []).filter((h) => h.time > (r.clearedAt || 0)),
      tracking: r.tracking || null
    };
  });
  return new Response(JSON.stringify({ locations }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" }
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
  "birdsRiversEnabledByDefault", "diagnosticsEnabled", "gmailRouteImportEnabled",
  "positionShare", "riverLevels", "devices", "mapDataMaxAgeHours", "eta", "mode"
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
const MAP_SOURCE_KEYS = new Set(["id", "name", "url", "attribution", "type", "bounds", "maxNativeZoom", "requiresKey", "enabled"]);
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
  if (m.bounds !== undefined) {
    const b = m.bounds;
    if (!b || typeof b !== "object" || Array.isArray(b) ||
        !Object.keys(b).every((k) => ["south", "west", "north", "east"].includes(k)) ||
        !inRange(b.south, -90, 90) || !inRange(b.north, -90, 90) ||
        !inRange(b.west, -180, 180) || !inRange(b.east, -180, 180) ||
        b.south >= b.north || b.west >= b.east) return `${at}.bounds invalid`;
  }
  if (m.maxNativeZoom !== undefined && (!Number.isInteger(m.maxNativeZoom) || m.maxNativeZoom < 0 || m.maxNativeZoom > 19)) {
    return `${at}.maxNativeZoom invalid`;
  }
  if (m.enabled !== undefined && !isBool(m.enabled)) return `${at}.enabled invalid`;
  if (m.requiresKey !== undefined && !isBool(m.requiresKey)) return `${at}.requiresKey invalid`;
  if (!isStr(m.url, 300)) return `${at}.url invalid (max 300 chars)`;
  if (m.url.startsWith("maps/")) {
    if (!/^maps\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/\{z\}\/\{x\}\/\{y\}\.[A-Za-z0-9]+$/.test(m.url) ||
        m.url.split("/").includes("..")) return `${at}.url must be a safe relative tile path`;
  } else {
    if (!/^https:\/\//.test(m.url)) return `${at}.url must be https or a relative maps/ tile path`;
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
  if (s.mode !== undefined && s.mode !== "normal" && s.mode !== "test") return "mode must be normal or test";
  if (s.mapDataMaxAgeHours !== undefined &&
      (!Number.isInteger(s.mapDataMaxAgeHours) || s.mapDataMaxAgeHours < 1 || s.mapDataMaxAgeHours > 720)) {
    return "mapDataMaxAgeHours must be a whole number from 1 to 720";
  }
  if (s.eta !== undefined) {
    const eta = s.eta;
    if (!eta || typeof eta !== "object" || Array.isArray(eta) ||
        !Object.keys(eta).every((k) => ["enabled", "staleMinutes", "lunchTime", "lunchDurationMinutes"].includes(k))) {
      return "eta invalid";
    }
    if (eta.enabled !== undefined && !isBool(eta.enabled)) return "eta.enabled invalid";
    if (eta.staleMinutes !== undefined && (!Number.isInteger(eta.staleMinutes) || eta.staleMinutes < 10 || eta.staleMinutes > 720)) {
      return "eta.staleMinutes must be a whole number from 10 to 720";
    }
    if (eta.lunchTime !== undefined && (typeof eta.lunchTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(eta.lunchTime))) {
      return "eta.lunchTime must be HH:MM";
    }
    if (eta.lunchDurationMinutes !== undefined &&
        (!Number.isInteger(eta.lunchDurationMinutes) || eta.lunchDurationMinutes < 0 || eta.lunchDurationMinutes > 240)) {
      return "eta.lunchDurationMinutes must be a whole number from 0 to 240";
    }
  }
  for (const k of ["weatherEnabledByDefault", "birdsRiversEnabledByDefault", "diagnosticsEnabled", "gmailRouteImportEnabled"]) {
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
  if (s.devices !== undefined) {
    if (!Array.isArray(s.devices) || s.devices.length > 50) return "devices must be a list of at most 50";
    const seen = new Set();
    for (const d of s.devices) {
      if (!d || typeof d !== "object" || !Object.keys(d).every((k) =>
        ["imei", "name", "etaRouteId", "etaDirection", "etaFallbackSpeedKmh"].includes(k)) ||
          typeof d.imei !== "string" || !/^\d{15}$/.test(d.imei) || !isStr(d.name, 40) || !d.name.trim() ||
          seen.has(d.imei)) return "devices invalid";
      if (d.etaRouteId !== undefined && !isStr(d.etaRouteId, 500)) return "devices etaRouteId invalid";
      if (d.etaDirection !== undefined && d.etaDirection !== "forward" && d.etaDirection !== "reverse") return "devices etaDirection invalid";
      if (d.etaFallbackSpeedKmh !== undefined && !inRange(d.etaFallbackSpeedKmh, 0.1, 160)) return "devices etaFallbackSpeedKmh invalid";
      seen.add(d.imei);
    }
  }
  const ps = s.positionShare;
  if (ps !== undefined) {
    if (!ps || typeof ps !== "object" || Array.isArray(ps)) return "positionShare invalid";
    if (!Object.keys(ps).every((k) => ["persistenceMinutes", "updateMinutes", "autoStopHours"].includes(k))) {
      return "positionShare has unknown fields";
    }
    if (ps.persistenceMinutes !== undefined &&
        (!Number.isInteger(ps.persistenceMinutes) || ps.persistenceMinutes < 10 || ps.persistenceMinutes > 120)) {
      return "positionShare.persistenceMinutes must be a whole number from 10 to 120";
    }
    if (ps.updateMinutes !== undefined &&
        (!Number.isInteger(ps.updateMinutes) || ps.updateMinutes < 1 || ps.updateMinutes > 60)) {
      return "positionShare.updateMinutes must be a whole number from 1 to 60";
    }
    if (ps.autoStopHours !== undefined &&
        (!Number.isInteger(ps.autoStopHours) || ps.autoStopHours < 1 || ps.autoStopHours > 24)) {
      return "positionShare.autoStopHours must be a whole number from 1 to 24";
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
  if (env.RATE_LIMIT) await env.RATE_LIMIT.put(CFG_KEY, JSON.stringify(ipcConfigFrom(settings)));

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

async function importRouteCard(request, env) {
  const raw = await request.text();
  if (raw.length > MAX_UPLOAD_B64 + 2000) return json({ error: "Too large" }, 413);
  let req;
  try { req = JSON.parse(raw); } catch (e) { return json({ error: "Bad JSON" }, 400); }

  if (typeof req.cardBase64 !== "string" || !req.cardBase64 || req.cardBase64.length > MAX_UPLOAD_B64 ||
      !/^[A-Za-z0-9+/=\r\n]+$/.test(req.cardBase64)) {
    return json({ error: "Invalid route card content" }, 400);
  }

  try {
    const buffer = Uint8Array.from(atob(req.cardBase64), (char) => char.charCodeAt(0));
    const route = parseRouteCard(new Uint8Array(buffer));
    const kml = routeCardToKml(route);
    const kmlBase64 = btoa(kml);
    return json({ ok: true, name: route.routeName, contentBase64: kmlBase64 }, 200);
  } catch (e) {
    return json({ error: `Failed to parse route card: ${e.message}` }, 400);
  }
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

function gmailSenders(env) {
  const raw = env.GMAIL_ALLOWED_SENDERS || "";
  const senders = raw.split(/[,\s]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!senders.length || senders.some((sender) => !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(sender))) {
    throw new Error("GMAIL_ALLOWED_SENDERS must contain one or more valid sender email addresses");
  }
  return [...new Set(senders)];
}

async function gmailAccessToken(env) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error("Gmail OAuth secrets are not configured");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  if (!response.ok) throw new Error(`Gmail OAuth token refresh failed (HTTP ${response.status})`);
  const token = await response.json();
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("Gmail OAuth response did not contain an access token");
  }
  return token.access_token;
}

async function gmailGet(path, accessToken) {
  const response = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const error = new Error(`Gmail API request failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeBase64Utf8(value) {
  return new TextDecoder().decode(decodeBase64Url(value.replace(/\s/g, "")));
}

function gmailSender(message) {
  const headers = message.payload && message.payload.headers || [];
  const from = headers.find((header) => header.name.toLowerCase() === "from");
  const match = from && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(from.value);
  return match ? match[0].toLowerCase() : "";
}

function gmailAttachments(payload, result = []) {
  if (!payload) return result;
  if (payload.filename && /\.docx$/i.test(payload.filename)) result.push(payload);
  (payload.parts || []).forEach((part) => gmailAttachments(part, result));
  return result;
}

function londonImportDate(internalDate) {
  const date = new Date(Number(internalDate));
  if (!Number.isFinite(date.getTime())) throw new Error("Gmail message has an invalid received date");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function attachmentBytes(messageId, part, accessToken) {
  const body = part.body || {};
  let bytes;
  if (body.data) {
    bytes = decodeBase64Url(body.data);
  } else if (body.attachmentId) {
    const result = await gmailGet(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(body.attachmentId)}`,
      accessToken
    );
    bytes = decodeBase64Url(result.data || "");
  } else {
    throw new Error("DOCX attachment has no downloadable content");
  }
  if (!bytes.length || bytes.length > MAX_GMAIL_DOCX_BYTES) {
    throw new Error("DOCX attachment is empty or exceeds the 8 MB size limit");
  }
  return bytes;
}

async function commitImportedRoute(env, folder, route, gmailMessageId) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not configured");
  const routeFilename = `${route.routeName}.kml`;
  const routePath = `routes/${folder}/${routeFilename}`;
  const ref = await gh(env, `/git/ref/heads/${GH_BRANCH}`);
  const headSha = ref.object.sha;
  const head = await gh(env, `/git/commits/${headSha}`);
  const tree = (await gh(env, `/git/trees/${head.tree.sha}?recursive=1`)).tree || [];
  if (tree.some((item) => item.path === routePath)) {
    return { imported: false, reason: "A route with this name is already in the daily folder" };
  }

  const settingsFile = await gh(env, `/contents/settings.json?ref=${encodeURIComponent(headSha)}`);
  const settings = JSON.parse(decodeBase64Utf8(settingsFile.content));
  settings.defaultRouteFolder = folder;
  const routeId = `${folder}/${routeFilename}#0`;
  (settings.devices || []).forEach((device) => {
    if (device.etaRouteId === routeId) device.etaFallbackSpeedKmh = route.defaultSpeedKmh;
  });

  const kmlBlob = await gh(env, "/git/blobs", {
    method: "POST",
    body: JSON.stringify({
      content: toBase64Utf8(routeCardToKml(route)),
      encoding: "base64"
    })
  });
  const settingsBlob = await gh(env, "/git/blobs", {
    method: "POST",
    body: JSON.stringify({ content: JSON.stringify(settings, null, 2) + "\n", encoding: "utf-8" })
  });
  const changes = [
    { path: routePath, mode: "100644", type: "blob", sha: kmlBlob.sha },
    { path: "settings.json", mode: "100644", type: "blob", sha: settingsBlob.sha }
  ];
  if (!tree.some((item) => item.path.startsWith(`routes/${folder}/`))) {
    const keepBlob = await gh(env, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: "\n", encoding: "utf-8" })
    });
    changes.push({ path: `routes/${folder}/${KEEP_FILE}`, mode: "100644", type: "blob", sha: keepBlob.sha });
  }

  const newTree = await gh(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: head.tree.sha, tree: changes })
  });
  const commit = await gh(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: `Import route card ${route.routeName} from Gmail ${gmailMessageId}`,
      tree: newTree.sha,
      parents: [headSha]
    })
  });
  await gh(env, `/git/refs/heads/${GH_BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha })
  });
  await caches.default.delete(new Request(ROUTES_CACHE_KEY));
  return { imported: true, routePath };
}

async function pollGmailRouteCards(env) {
  if (!env.RATE_LIMIT) throw new Error("RATE_LIMIT KV binding is required for Gmail import deduplication");
  const senders = gmailSenders(env);
  const accessToken = await gmailAccessToken(env);
  const senderQuery = senders.map((sender) => `from:${sender}`).join(" ");
  const query = `in:inbox has:attachment filename:docx newer_than:30d {${senderQuery}}`;
  const cursorKey = `${GMAIL_IMPORT_PREFIX}cursor`;
  const cursor = await env.RATE_LIMIT.get(cursorKey);
  const listPath = (pageToken) =>
    `/messages?q=${encodeURIComponent(query)}&maxResults=${MAX_GMAIL_MESSAGES_PER_POLL}` +
    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
  let list;
  try {
    list = await gmailGet(listPath(cursor), accessToken);
  } catch (error) {
    if (!cursor || error.status !== 400) throw error;
    console.warn("Gmail polling cursor expired; restarting from the newest matching messages");
    await env.RATE_LIMIT.delete(cursorKey);
    list = await gmailGet(listPath(""), accessToken);
  }
  const messages = list.messages || [];
  let importedCardCount = 0;
  let completedPage = true;
  for (const summary of messages) {
    const message = await gmailGet(`/messages/${encodeURIComponent(summary.id)}?format=full`, accessToken);
    if (!senders.includes(gmailSender(message))) continue;
    const parts = gmailAttachments(message.payload);
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const attachmentKey = part.body && part.body.attachmentId || `${partIndex}:${part.filename}`;
      const stateKey = `${GMAIL_IMPORT_PREFIX}${message.id}:${attachmentKey}`;
      if (await env.RATE_LIMIT.get(stateKey)) continue;

      let bytes;
      try {
        bytes = await attachmentBytes(message.id, part, accessToken);
      } catch (error) {
        if (error.status || error instanceof TypeError) {
          console.error("Gmail route-card attachment download failed; it will be retried", {
            messageId: message.id,
            filename: part.filename,
            reason: String(error.message || error).slice(0, 300)
          });
          continue;
        }
        await env.RATE_LIMIT.put(stateKey, JSON.stringify({
          status: "rejected",
          message: String(error.message || error).slice(0, 300),
          at: new Date().toISOString()
        }), { expirationTtl: GMAIL_IMPORT_TTL_SECONDS });
        console.error("Gmail route card rejected", {
          messageId: message.id,
          filename: part.filename,
          reason: String(error.message || error).slice(0, 300)
        });
        continue;
      }

      let route;
      try {
        route = parseRouteCard(bytes);
      } catch (error) {
        await env.RATE_LIMIT.put(stateKey, JSON.stringify({
          status: "rejected",
          message: String(error.message || error).slice(0, 300),
          at: new Date().toISOString()
        }), { expirationTtl: GMAIL_IMPORT_TTL_SECONDS });
        console.error("Gmail route card rejected", {
          messageId: message.id,
          filename: part.filename,
          reason: String(error.message || error).slice(0, 300)
        });
        continue;
      }

      let result;
      try {
        const folder = londonImportDate(message.internalDate);
        result = await commitImportedRoute(env, folder, route, message.id);
      } catch (error) {
        console.error("Gmail route card import failed; it will be retried", {
          messageId: message.id,
          routeName: route.routeName,
          reason: String(error.message || error).slice(0, 300)
        });
        continue;
      }
      await env.RATE_LIMIT.put(stateKey, JSON.stringify({
        status: result.imported ? "imported" : "duplicate",
        routePath: result.routePath || "",
        reason: result.reason || "",
        at: new Date().toISOString()
      }), { expirationTtl: GMAIL_IMPORT_TTL_SECONDS });
      if (result.imported) {
        console.info("Gmail route card imported", {
          messageId: message.id,
          routePath: result.routePath,
          defaultSpeedKmh: route.defaultSpeedKmh,
          waypointCount: route.waypoints.length
        });
      } else {
        console.warn("Gmail route card was not imported", {
          messageId: message.id,
          routeName: route.routeName,
          reason: result.reason
        });
      }
      importedCardCount += 1;
      if (importedCardCount >= MAX_GMAIL_CARDS_PER_POLL) {
        completedPage = false;
        break;
      }
    }
    if (!completedPage) break;
  }
  if (completedPage && list.nextPageToken) {
    await env.RATE_LIMIT.put(cursorKey, list.nextPageToken, { expirationTtl: GMAIL_IMPORT_TTL_SECONDS });
  } else if (completedPage) {
    await env.RATE_LIMIT.delete(cursorKey);
  }
}

// ---- Position Share ------------------------------------------------
// GPS-based position sharing from website users. Positions stored in KV
// with TTL-based expiration. Maximum 24 concurrent users.

async function sharePosition(request, env) {
  const raw = await request.text();
  if (raw.length > 10000) return json({ error: "Too large" }, 413);
  let req;
  try { req = JSON.parse(raw); } catch (e) { return json({ error: "Bad JSON" }, 400); }

  // Validate required fields
  if (typeof req.latitude !== "number" || typeof req.longitude !== "number" ||
      !Number.isFinite(req.latitude) || !Number.isFinite(req.longitude) ||
      req.latitude < -90 || req.latitude > 90 || req.longitude < -180 || req.longitude > 180) {
    return json({ error: "Invalid latitude/longitude" }, 400);
  }
  if (typeof req.name !== "string" || !req.name || req.name.length > 4 ||
      !/^[A-Za-z0-9\-. ]+$/.test(req.name)) {
    return json({ error: "Invalid name (max 4 characters, alphanumeric/space/dash/dot)" }, 400);
  }
  if (typeof req.timestamp !== "number" || !Number.isFinite(req.timestamp) || req.timestamp <= 0) {
    return json({ error: "Invalid timestamp" }, 400);
  }

  // Get persistence timeout from settings (default 20 minutes)
  const config = await ipcConfig(env);
  const persistenceMinutes = config.positionSharePersistenceMinutes ||
    POSITION_SHARE_DEFAULT_PERSISTENCE_MINUTES;
  if (persistenceMinutes < 10 || persistenceMinutes > 120) {
    return json({ error: "Invalid position share persistence setting" }, 500);
  }

  // Generate a unique session ID (using timestamp + name hash)
  const sessionId = req.sessionId || `${Math.floor(Date.now() / 1000)}-${req.name.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const kvKey = `${POSITION_SHARE_PREFIX}${sessionId}`;

  // Check current user count (excluding this session to allow updates)
  if (!env.RATE_LIMIT) {
    return json({ error: "KV store not configured" }, 500);
  }

  try {
    const position = {
      sessionId,
      name: req.name,
      latitude: req.latitude,
      longitude: req.longitude,
      timestamp: req.timestamp,
      elevation: req.elevation || null
    };

    // Store position with TTL in minutes
    const ttlSeconds = persistenceMinutes * 60;
    await env.RATE_LIMIT.put(kvKey, JSON.stringify(position), { expirationTtl: ttlSeconds });

    return json({ ok: true, sessionId }, 200);
  } catch (e) {
    console.error("Failed to store position", e);
    return json({ error: "Failed to store position" }, 500);
  }
}

async function getPositions(env) {
  if (!env.RATE_LIMIT) {
    return json({ positions: [] }, 200);
  }

  try {
    // List all position keys with prefix
    const list = await env.RATE_LIMIT.list({ prefix: POSITION_SHARE_PREFIX });

    const positions = [];
    for (const key of list.keys) {
      try {
        const data = await env.RATE_LIMIT.get(key.name, "json");
        if (data) {
          positions.push(data);
        }
      } catch (e) {
        // Skip malformed entries
        console.warn(`Failed to parse position ${key.name}`, e);
      }
    }

    // Sort by name for consistent ordering
    positions.sort((a, b) => a.name.localeCompare(b.name));

    return json({ positions }, 200);
  } catch (e) {
    console.error("Failed to retrieve positions", e);
    return json({ positions: [] }, 200);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const config = await ipcConfig(env);
      if (config.gmailRouteImportEnabled === false) {
        console.info("Scheduled Gmail route-card poll skipped; email checking is disabled");
        return;
      }
      await pollGmailRouteCards(env);
    })().catch((error) => {
      console.error("Scheduled Gmail route-card poll failed", error);
    }));
  },
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/ipc/outbound") {
      const logRequest = request.clone();
      let res;
      try { res = await ipcReceive(request, env); } catch (e) { res = json({ error: "Server error" }, 500); }
      try { await ipcLog(env, logRequest, res); } catch (e) { /* logging is best effort */ }
      return res;
    }
    if (request.method === "POST" && pathname === "/ipc/command") {
      try {
        if (!(await passphraseOk(request, env))) return json({ error: "Unauthorized" }, 401);
        return await ipcCommand(request, env);
      } catch (e) { return json({ error: "Server error" }, 500); }
    }
    if (request.method === "POST" && pathname === "/ipc/test") {
      try {
        if (!(await passphraseOk(request, env))) return json({ error: "Unauthorized" }, 401);
        return await ipcTest(request, env);
      } catch (e) { return json({ error: "Server error" }, 500); }
    }
    if (request.method === "POST" && (pathname === "/settings" || pathname === "/settings/verify" || pathname === "/routes/manage" || pathname === "/routes/import-card")) {
      try {
        if (!(await passphraseOk(request, env))) return json({ error: "Unauthorized" }, 401);
        if (pathname === "/settings/verify") return json({ ok: true }, 200);
        if (pathname === "/routes/import-card") return await importRouteCard(request, env);
        if (pathname === "/routes/manage") return await manageRoutes(request, env, ctx);
        return await saveSettings(request, env);
      } catch (e) {
        return json({ error: "Server error" }, 500);
      }
    }
    if (request.method === "POST" && pathname === "/positions/share") {
      try {
        return await sharePosition(request, env);
      } catch (e) {
        return json({ error: "Server error" }, 500);
      }
    }
    if (request.method === "GET" && pathname === "/positions") {
      try {
        return await getPositions(env);
      } catch (e) {
        return json({ error: "Server error" }, 500);
      }
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    try {
      if (pathname === "/") return await garmin(env);
      if (pathname === "/routes") return await routesManifest(env, ctx);
      if (pathname === "/ipc/locations") return await ipcLocations(new URL(request.url), env);
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
