// settings-store.js - loads/merges settings and persists changes.
//
// Precedence (lowest to highest): settings.json (repo default) -> localStorage
// override (per-browser tweaks / fallback when not saved to GitHub).
(function (global) {
  "use strict";

  const LOCAL_KEY = "maynard_settings_override_v1";

  let cached = null;

  function readLocalOverride() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn("Could not read local settings override", e);
      return {};
    }
  }

  function writeLocalOverride(obj) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn("Could not persist local settings override", e);
    }
  }

  function deepMerge(base, override) {
    if (Array.isArray(base) || Array.isArray(override)) {
      return override !== undefined ? override : base;
    }
    if (typeof base === "object" && base && typeof override === "object" && override) {
      const out = { ...base };
      for (const key of Object.keys(override)) {
        out[key] = deepMerge(base[key], override[key]);
      }
      return out;
    }
    return override !== undefined ? override : base;
  }

  async function load() {
    if (cached) return cached;
    const cfg = global.MAYNARD_CONFIG;
    let defaults;
    try {
      defaults = await global.MaynardUtils.fetchJson(cfg.defaultSettingsUrl, { timeoutMs: 8000 });
    } catch (e) {
      console.warn("settings.json unavailable, using built-in fallback defaults", e);
      defaults = {
        github: cfg.github,
        defaultRouteFolder: "TT1",
        startPoint: { lat: 51.5074, lng: -0.1278 },
        startZoom: 12,
        mapSources: [],
        routeColours: {},
        kmlMarkerColour: "#1565c0",
        weatherEnabledByDefault: false,
        birdsRiversEnabledByDefault: false
      };
    }
    const override = readLocalOverride();
    cached = deepMerge(defaults, override);
    return cached;
  }

  function getCached() {
    return cached;
  }

  // Persist to localStorage immediately (always works offline) and ask the
  // Worker (which holds the GitHub token) to commit settings.json.
  async function save(newSettings, passphrase) {
    cached = newSettings;
    writeLocalOverride(newSettings);

    try {
      await global.MaynardGithubSave.commitSettingsJson(newSettings, passphrase);
      return { localSaved: true, githubSaved: true };
    } catch (e) {
      console.error("GitHub save failed", e);
      return { localSaved: true, githubSaved: false, reason: e.message };
    }
  }

  function resetLocalOverride() {
    localStorage.removeItem(LOCAL_KEY);
    cached = null;
  }

  global.MaynardSettings = { load, getCached, save, resetLocalOverride };
})(window);
