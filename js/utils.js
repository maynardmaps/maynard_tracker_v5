// utils.js - small shared helpers, no dependencies.
(function (global) {
  "use strict";

  // Colours are generic slots, not tied to specific files: the Nth route (or
  // marker), in alphanumerical order, gets slot N; beyond the palette length
  // the slots repeat. Palettes are configured on the configuration page.
  const PALETTE_SIZE = 8;
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

  function debounce(fn, waitMs) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), waitMs);
    };
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

  // Tries each configured CORS proxy in turn until one succeeds. Used for
  // third-party feeds (Garmin KML, Met Office images) that a static site has
  // no backend to request on the page's behalf.
  async function fetchViaCorsProxies(targetUrl, proxies, opts) {
    let lastErr;
    for (const proxyPrefix of proxies) {
      try {
        const proxied = proxyPrefix + encodeURIComponent(targetUrl);
        return await fetchText(proxied, opts);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All CORS proxies failed");
  }

  function base64EncodeUtf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
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
    PALETTE_SIZE,
    assignColours,
    debounce,
    fetchJson,
    fetchText,
    fetchViaCorsProxies,
    base64EncodeUtf8
  };
})(window);
