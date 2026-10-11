// river-levels.js - Environment Agency river level stations (England) shown as
// small coloured dots. Data: https://environment.data.gov.uk/flood-monitoring
// (open data, no API key, CORS enabled). Loaded lazily the first time the
// overlay is switched on.
(function (global) {
  "use strict";

  const API = "https://environment.data.gov.uk/flood-monitoring";
  const STATION_CACHE_KEY = "maynard_river_stations_v1";
  const STATION_CACHE_MS = 7 * 24 * 3600 * 1000;
  const REFRESH_MS = 15 * 60 * 1000;

  const COLOURS = { low: "#8d6e63", normal: "#2e9d4a", high: "#f39c12", veryHigh: "#d32f2f", unknown: "#8a8a8a" };
  const BAND_TEXT = {
    low: "Below normal for this location",
    normal: "Within the usual range for this location",
    high: "Above normal for this location",
    veryHigh: "Very high for this location",
    unknown: "No typical range available"
  };

  let layer = null;
  let bounds = null;
  let visible = false;
  let stations = [];
  let readings = {};
  let timer = null;
  let loadSeq = 0;
  let loading = null;
  let trends = {};
  const BULK_THRESHOLD = 150;

  const esc = MaynardUtils.escapeHtml;
  const idOf = (url) => String(url).split("/").pop();

  function haversineKm(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  function inBounds(s, b) {
    return s.lat >= b.south && s.lat <= b.north && s.lng >= b.west && s.lng <= b.east;
  }

  function boundsKey(b) {
    return [b.south, b.west, b.north, b.east].map((n) => Number(n).toFixed(3)).join(",");
  }

  function slimStation(st) {
    const sc = st.stageScale && typeof st.stageScale === "object" ? st.stageScale : {};
    const measures = (Array.isArray(st.measures) ? st.measures : st.measures ? [st.measures] : [])
      .map((m) => ({ id: idOf(m["@id"]), qualifier: m.qualifier || "", unit: m.unitName || "m" }));
    return {
      id: String(st.notation || idOf(st["@id"])),
      label: st.label || "",
      river: st.riverName || "",
      lat: st.lat,
      lng: st.long,
      measures,
      low: sc.typicalRangeLow,
      high: sc.typicalRangeHigh,
      record: sc.highestRecent && sc.highestRecent.value
    };
  }

  async function loadStations(b) {
    const key = boundsKey(b);
    try {
      const c = JSON.parse(localStorage.getItem(STATION_CACHE_KEY) || "null");
      if (c && c.key === key && Date.now() - c.at < STATION_CACHE_MS) return c.stations;
    } catch (e) { /* ignore bad cache */ }

    const cLat = (b.south + b.north) / 2;
    const cLng = (b.west + b.east) / 2;
    const dist = Math.ceil(haversineKm(cLat, cLng, b.north, b.east)) + 1;
    const url = `${API}/id/stations?parameter=level&_view=full&_limit=10000` +
      `&lat=${cLat.toFixed(5)}&long=${cLng.toFixed(5)}&dist=${dist}`;
    const data = await MaynardUtils.fetchJson(url, { timeoutMs: 30000 });
    const list = (data.items || [])
      .map(slimStation)
      .filter((s) => isFinite(s.lat) && isFinite(s.lng) && s.measures.length && inBounds(s, b));
    try {
      localStorage.setItem(STATION_CACHE_KEY, JSON.stringify({ key, at: Date.now(), stations: list }));
    } catch (e) { /* too big for storage: just refetch next time */ }
    return list;
  }

  async function loadReadings() {
    const data = await MaynardUtils.fetchJson(`${API}/data/readings?latest&parameter=level&_limit=10000`, { timeoutMs: 20000 });
    const out = {};
    (data.items || []).forEach((r) => { out[idOf(r.measure)] = r; });
    return out;
  }

  // Prefer the plain "Stage" measure, otherwise the first one that has a reading.
  function pickMeasure(s) {
    const withReading = s.measures.filter((m) => readings[m.id]);
    if (!withReading.length) return null;
    return withReading.find((m) => m.qualifier === "Stage") || withReading[0];
  }

  function bandOf(s, value) {
    if (!isFinite(s.low) || !isFinite(s.high)) return "unknown";
    if (isFinite(s.record) && value >= s.record) return "veryHigh";
    if (value < s.low) return "low";
    if (value > s.high) return "high";
    return "normal";
  }

  function popupHtml(s, m, r, band) {
    const when = new Date(r.dateTime);
    const t = isNaN(when) ? "" : when.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    return `<div class="kml-popup river-popup" data-measure="${esc(m.id)}" data-value="${r.value}"><strong>${esc(s.label)}</strong>` +
      `<table class="kml-popup-table">` +
      (s.river ? `<tr><th>Watercourse</th><td>${esc(s.river)}</td></tr>` : "") +
      `<tr><th>Level</th><td>${r.value} ${esc(m.unit)} <span class="river-trend">&hellip;</span></td></tr>` +
      `<tr><th>Status</th><td>${BAND_TEXT[band]}</td></tr>` +
      (t ? `<tr><th>Reading</th><td>${esc(t)}</td></tr>` : "") +
      `</table></div>`;
  }

  // Trend is looked up only when a popup is opened, to keep the overlay light.
  async function fillTrend(el) {
    const measure = el.dataset.measure;
    const slot = el.querySelector(".river-trend");
    if (!slot) return;
    try {
      const data = await MaynardUtils.fetchJson(`${API}/id/measures/${encodeURIComponent(measure)}/readings?_sorted&_limit=6`, { timeoutMs: 10000 });
      const t = trendOf(data.items || []);
      slot.textContent = t === "steady" ? "\u2192 Steady" : t === "rising" ? "\u2191 Rising" : t === "falling" ? "\u2193 Falling" : "";
    } catch (e) {
      slot.textContent = "";
    }
  }

  const ROTATE = { rising: 0, falling: 180, steady: 90 };

  function trendOf(items) {
    if (!items || items.length < 2) return null;
    const diff = items[0].value - items[items.length - 1].value;
    return Math.abs(diff) < 0.01 ? "steady" : diff > 0 ? "rising" : "falling";
  }

  // Arrow (up = rising, down = falling, right = steady) the size of the team
  // diamonds; a small dot is shown until the trend is known.
  function iconFor(band, trend) {
    const colour = COLOURS[band];
    const html = trend
      ? `<svg viewBox="0 0 20 20" width="18" height="18" style="transform:rotate(${ROTATE[trend]}deg)">` +
        `<path d="M10 1 L18 11 H13 V19 H7 V11 H2 Z" fill="${colour}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`
      : `<span class="river-dot" style="background:${colour}"></span>`;
    return L.divIcon({ className: "river-arrow", html, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  let markers = {};

  function setTrend(id, trend) {
    trends[id] = trend;
    const e = markers[id];
    if (e && trend) e.marker.setIcon(iconFor(e.band, trend));
  }

  async function loadTrendsPerStation(seq) {
    const queue = Object.keys(markers);
    const worker = async () => {
      while (queue.length && seq === loadSeq) {
        const id = queue.shift();
        try {
          const d = await MaynardUtils.fetchJson(`${API}/id/measures/${encodeURIComponent(markers[id].measureId)}/readings?_sorted&_limit=5`, { timeoutMs: 15000 });
          setTrend(id, trendOf(d.items));
        } catch (e) { /* leave as dot */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  }

  // Large areas: one bulk request of the most recent readings instead of one per station.
  async function loadTrendsBulk(seq) {
    const d = await MaynardUtils.fetchJson(`${API}/data/readings?parameter=level&_sorted&_limit=10000&startdate=${new Date().toISOString().slice(0, 10)}`, { timeoutMs: 60000 });
    const byMeasure = {};
    (d.items || []).forEach((r) => { const k = idOf(r.measure); (byMeasure[k] = byMeasure[k] || []).push(r); });
    if (seq !== loadSeq) return;
    Object.keys(markers).forEach((id) => {
      const list = byMeasure[markers[id].measureId];
      if (list) setTrend(id, trendOf(list.slice(0, 5)));
    });
  }

  function render(seq) {
    if (!layer) return;
    layer.clearLayers();
    markers = {};
    stations.forEach((s) => {
      const m = pickMeasure(s);
      if (!m) return;
      const r = readings[m.id];
      if (typeof r.value !== "number") return;
      const band = bandOf(s, r.value);
      const marker = L.marker([s.lat, s.lng], { icon: iconFor(band, trends[s.id]), keyboard: false })
        .bindPopup(popupHtml(s, m, r, band), { maxWidth: 260 })
        .on("popupopen", (e) => {
          const el = e.popup.getElement() && e.popup.getElement().querySelector(".river-popup");
          if (el) fillTrend(el);
        })
        .addTo(layer);
      markers[s.id] = { marker, band, measureId: m.id };
    });
    const n = Object.keys(markers).length;
    (n > BULK_THRESHOLD ? loadTrendsBulk(seq) : loadTrendsPerStation(seq))
      .catch((e) => console.warn("River trends failed", e));
  }

  async function refresh() {
    const seq = ++loadSeq;
    if (!Object.keys(markers).length) MaynardUtils.setStatus("river", "Loading river levels\u2026");
    try {
      if (!stations.length) stations = await loadStations(bounds);
      readings = await loadReadings();
      if (seq === loadSeq) { trends = {}; render(seq); MaynardUtils.setStatus("river", null); }
    } catch (e) {
      console.warn("River levels load failed", e);
      MaynardUtils.setStatus("river", Object.keys(markers).length ? "River levels could not be refreshed" : "River levels unavailable");
    }
  }

  function start() {
    if (!loading) loading = refresh().finally(() => { loading = null; });
    if (!timer) timer = setInterval(() => { if (visible) refresh(); }, REFRESH_MS);
  }

  function init(map, { bounds: b, startVisible }) {
    bounds = b;
    layer = L.featureGroup();
    visible = startVisible === true;
    if (visible) { layer.addTo(map); start(); }
  }

  function setVisible(v, map) {
    visible = v;
    if (!layer) return;
    if (visible) { layer.addTo(map); if (!stations.length) start(); }
    else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
      MaynardUtils.setStatus("river", null);
    }
  }

  function reattach(map) {
    if (layer && visible) layer.addTo(map);
  }

  global.MaynardRiverLevels = { init, setVisible, reattach };
})(window);
