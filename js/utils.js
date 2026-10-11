// utils.js - small shared helpers, no dependencies.
(function (global) {
  "use strict";

  // Colours are generic slots, not tied to specific files: the Nth route (or
  // marker), in alphanumerical order, gets slot N; beyond the palette length
  // the slots repeat. Palettes are configured on the configuration page.
  const PALETTE_SIZE = 8; // palettes always have this many colours
  const DEFAULT_PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231",
    "#911eb4", "#46f0f0", "#f032e6", "#9a6324"
  ];

  // Returns a valid 8-colour palette, filling gaps/invalid values (or legacy
  // non-array settings) from the defaults.
  function sanitizePalette(palette) {
    const arr = Array.isArray(palette) ? palette : [];
    return DEFAULT_PALETTE.map((d, i) =>
      typeof arr[i] === "string" && /^#[0-9a-f]{6}$/i.test(arr[i]) ? arr[i] : d
    );
  }

  // Sorts names alphanumerically (case-insensitive, natural number ordering)
  // and returns a Map of name -> palette colour (cycling through the palette).
  function assignColours(names, palette) {
    const colours = sanitizePalette(palette);
    const sorted = names.slice().sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
    const result = new Map();
    sorted.forEach((name, i) => result.set(name, colours[i % colours.length]));
    return result;
  }

  // Fetch JSON with a hard timeout so a slow/unreachable endpoint (relevant
  // for the "limited connectivity" requirement) doesn't hang the UI forever.
  async function fetchJson(url, { timeoutMs = 10000, ...opts } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchText(url, { timeoutMs = 10000, ...opts } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
  const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

  // EPSG:27700 (British National Grid) definition, shared by the map and grid refs.
  const BNG_PROJ4 = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs";

  // Small status line over the map (e.g. "River levels unavailable"). Each
  // feature owns a key; pass a falsy message to clear it.
  const statusMessages = new Map();
  function setStatus(key, message) {
    if (message) statusMessages.set(key, message); else statusMessages.delete(key);
    const el = document.getElementById("map-status");
    if (!el) return;
    el.textContent = [...statusMessages.values()].join(" \u00b7 ");
    el.hidden = statusMessages.size === 0;
  }

  // Live folder listing from the relay (auto-detects new route folders/files);
  // falls back to the static routes/manifest.json if the relay is unreachable.
  async function loadRoutesManifest() {
    const cfg = window.MAYNARD_CONFIG;
    if (cfg.garminRelayUrl) {
      try {
        const live = await fetchJson(cfg.garminRelayUrl.replace(/\/$/, "") + "/routes", { timeoutMs: 6000, cache: "no-store" });
        if (live && live.folders && Object.keys(live.folders).length) return live;
      } catch (e) {
        console.warn("Live route listing failed, using manifest.json", e);
      }
    }
    return fetchJson(cfg.routesManifestUrl, { timeoutMs: 8000 });
  }

  global.MaynardUtils = {
    loadRoutesManifest,
    sanitizePalette,
    DEFAULT_PALETTE,
    assignColours,
    fetchJson,
    fetchText,
    escapeHtml,
    setStatus,
    BNG_PROJ4
  };
})(window);
