// weather.js - "Weather data": Met Office Weather DataHub Map Images
// precipitation overlay with a forecast timeline slider. The DataHub API
// requires an "apikey" header and has no CORS support, so requests go via the
// Cloudflare Worker relay (which holds the key).
(function (global) {
  "use strict";

  const HOUR = 3600000;
  // Hourly for the next 12 hours, then every 6 hours up to 48 hours.
  const OFFSETS_HOURS = [];
  for (let h = 0; h <= 12; h++) OFFSETS_HOURS.push(h);
  for (let h = 18; h <= 48; h += 6) OFFSETS_HOURS.push(h);

  let map = null;
  let imageOverlay = null;
  let visible = false;
  let pollTimer = null;
  let steps = []; // [{ targetMs, file }]
  let selected = 0;
  let loadToken = 0;
  const urlCache = new Map(); // fileId -> object URL
  const PLAY_DELAY_MS = 1200;
  let playing = false;
  let playTimer = null;
  let clock = null; // Leaflet control showing the displayed overlay time
  let clockEl = null;
  let relayUrl = "";
  let bounds = null;

  async function relayFetch(path, binary) {
    const res = await fetch(`${relayUrl}/weather/${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return binary ? res.blob() : res.json();
  }

  // fileIds look like "total_precipitation_rate_ts{N}_{+RR|yyyyMMddRR}" where
  // N is the forecast timestep in hours from the model run (runDateTime).
  // Validity time = runDateTime + N hours. If several runs cover the same
  // validity time, the most recent run wins.
  function validityMap(fileList) {
    const tsPattern = /_ts(\d+)_/;
    const byValidity = new Map();
    for (const file of fileList) {
      const m = tsPattern.exec(file.fileId || "");
      if (!m || !file.runDateTime) continue;
      const run = new Date(file.runDateTime).getTime();
      const validity = run + parseInt(m[1], 10) * HOUR;
      const prev = byValidity.get(validity);
      if (!prev || run > prev.run) byValidity.set(validity, { file, run });
    }
    return byValidity;
  }

  function buildSteps(fileList) {
    const byValidity = validityMap(fileList);
    const times = [...byValidity.keys()];
    if (!times.length) return [];
    const base = Math.floor(Date.now() / HOUR) * HOUR;
    const out = [];
    const seen = new Set();
    for (const off of OFFSETS_HOURS) {
      const target = base + off * HOUR;
      let best = null;
      let bestDiff = Infinity;
      for (const t of times) {
        const d = Math.abs(t - target);
        if (d < bestDiff) { bestDiff = d; best = t; }
      }
      const tolerance = off <= 12 ? HOUR : 3 * HOUR;
      if (best === null || bestDiff > tolerance) continue;
      const file = byValidity.get(best).file;
      const id = file.fileId || file.id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ targetMs: best, offset: off, file });
    }
    return out;
  }

  function formatLabel(step) {
    const d = new Date(step.targetMs);
    const day = d.toLocaleDateString([], { weekday: "short" });
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const rel = step.offset === 0 ? "now" : `+${step.offset}h`;
    return `${day} ${time} (${rel})`;
  }

  function slider() { return document.getElementById("weather-slider"); }
  function label() { return document.getElementById("weather-time-label"); }
  function panel() { return document.getElementById("weather-timeline"); }

  function syncUi() {
    const p = panel();
    if (p) p.hidden = !(visible && steps.length > 0);
    const s = slider();
    if (s) {
      s.max = String(Math.max(0, steps.length - 1));
      s.value = String(selected);
    }
    const l = label();
    if (l) l.textContent = steps[selected] ? formatLabel(steps[selected]) : "";
    const b = document.getElementById("weather-play");
    if (b) b.innerHTML = playing ? "&#10074;&#10074; Pause" : "&#9654; Play";
    if (clockEl) {
      clockEl.textContent = steps[selected] ? "Precipitation: " + formatLabel(steps[selected]) : "";
      clockEl.parentNode.style.display = visible && steps[selected] ? "" : "none";
    }
  }

  function createClock() {
    clock = L.control({ position: "topright" });
    clock.onAdd = function () {
      const div = L.DomUtil.create("div", "weather-clock");
      div.style.display = "none";
      clockEl = L.DomUtil.create("span", "", div);
      return div;
    };
    clock.addTo(map);
  }

  function stopPlaying() {
    playing = false;
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
    syncUi();
  }

  function playNext() {
    if (!playing) return;
    const next = (selected + 1) % steps.length;
    showStep(next).then(() => {
      if (playing) playTimer = setTimeout(playNext, PLAY_DELAY_MS);
    });
  }

  function togglePlay() {
    if (playing) return stopPlaying();
    if (steps.length < 2) return;
    playing = true;
    syncUi();
    playTimer = setTimeout(playNext, 0);
  }

  async function showStep(index) {
    const step = steps[index];
    if (!step) return;
    selected = index;
    syncUi();
    const token = ++loadToken;
    const id = step.file.fileId || step.file.id;
    try {
      let url = urlCache.get(id);
      if (!url) {
        const blob = await relayFetch(`latest/${id}/data`, true);
        url = URL.createObjectURL(blob);
        urlCache.set(id, url);
      }
      if (token !== loadToken) return; // superseded by a later slider move
      const next = L.imageOverlay(url, [[bounds.south, bounds.west], [bounds.north, bounds.east]], { opacity: 0.6 });
      if (visible) next.addTo(map);
      if (imageOverlay && map.hasLayer(imageOverlay)) map.removeLayer(imageOverlay);
      imageOverlay = next;
    } catch (e) {
      console.warn("Met Office weather overlay load failed", e);
      MaynardUtils.diag("Weather image", false, e.message);
    }
  }

  async function refresh() {
    try {
      const latest = await relayFetch("latest", false);
      const fileList = (latest.orderDetails && latest.orderDetails.files) || latest.files || [];
      const next = buildSteps(fileList);
      if (!next.length) throw new Error("No usable Met Office image files returned");
      const prevId = steps[selected] && (steps[selected].file.fileId || steps[selected].file.id);
      steps = next;
      let idx = steps.findIndex((s) => (s.file.fileId || s.file.id) === prevId);
      const changed = idx < 0;
      if (changed) idx = 0;
      selected = idx;
      syncUi();
      if (visible && (!imageOverlay || changed)) showStep(idx);
      MaynardUtils.diag("Weather", true, "Met Office via Worker");
    } catch (e) {
      console.warn("Met Office weather overlay refresh failed", e);
      MaynardUtils.diag("Weather", false, e.message);
    }
  }

  function start(leafletMap, opts) {
    map = leafletMap;
    relayUrl = opts.relayUrl;
    bounds = opts.bounds;
    visible = opts.startVisible === true;
    if (!clock) createClock();
    const pb = document.getElementById("weather-play");
    if (pb && !pb.dataset.bound) {
      pb.dataset.bound = "1";
      pb.addEventListener("click", togglePlay);
    }
    const s = slider();
    if (s && !s.dataset.bound) {
      s.dataset.bound = "1";
      s.addEventListener("input", () => {
        if (playing) stopPlaying();
        const i = parseInt(s.value, 10);
        selected = i;
        const l = label();
        if (l && steps[i]) l.textContent = formatLabel(steps[i]);
      });
      s.addEventListener("change", () => showStep(parseInt(s.value, 10)));
    }
    refresh();
    stop();
    pollTimer = setInterval(refresh, opts.pollIntervalMs);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function setVisible(v, m) {
    visible = v;
    if (!visible && playing) stopPlaying();
    syncUi();
    if (!visible) {
      if (imageOverlay && m.hasLayer(imageOverlay)) m.removeLayer(imageOverlay);
      return;
    }
    if (imageOverlay) imageOverlay.addTo(m);
    else if (steps.length) showStep(selected);
  }

  function reattach(m) {
    if (imageOverlay && visible) imageOverlay.addTo(m);
  }

  global.MaynardWeather = { start, stop, setVisible, reattach };
})(window);