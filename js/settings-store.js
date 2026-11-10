// settings-store.js - loads/merges settings and persists changes.
//
// Shared settings are authoritative; local-only saves override them, with
// legacy local settings retained only when the shared file is unavailable.
(function (global) {
  "use strict";

  const LOCAL_KEY = "maynard_settings_override_v2";
  const LEGACY_LOCAL_KEY = "maynard_settings_override_v1";

  let cached = null;

  function readLocalOverride(useLegacyFallback) {
    try {
      const raw = localStorage.getItem(LOCAL_KEY) ||
        (useLegacyFallback ? localStorage.getItem(LEGACY_LOCAL_KEY) : null);
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

  function clearLocalOverride() {
    try {
      localStorage.removeItem(LOCAL_KEY);
      localStorage.removeItem(LEGACY_LOCAL_KEY);
    } catch (e) {
      console.warn("Could not clear local settings override", e);
    }
  }

  function clearLegacyLocalOverride() {
    try {
      localStorage.removeItem(LEGACY_LOCAL_KEY);
    } catch (e) {
      console.warn("Could not clear legacy local settings override", e);
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
    let usingFallbackDefaults = false;
    try {
      const settingsUrl = new URL(cfg.defaultSettingsUrl, global.location.href);
      settingsUrl.searchParams.set("_", Date.now().toString());
      defaults = await global.MaynardUtils.fetchJson(settingsUrl.toString(), {
        timeoutMs: 8000,
        cache: "no-store"
      });
    } catch (e) {
      console.warn("settings.json unavailable, using built-in fallback defaults", e);
      usingFallbackDefaults = true;
      defaults = {
        github: cfg.github,
        defaultRouteFolder: "TT1",
        startPoint: { lat: 51.5074, lng: -0.1278 },
        startZoom: 12,
        mapSources: [],
        routeColours: global.MaynardUtils.DEFAULT_PALETTE.slice(),
        markerColours: global.MaynardUtils.DEFAULT_PALETTE.slice(),
        weatherEnabledByDefault: false,
        birdsRiversEnabledByDefault: false
      };
    }
    const override = readLocalOverride(usingFallbackDefaults);
    if (!usingFallbackDefaults) clearLegacyLocalOverride();
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

    try {
      await global.MaynardGithubSave.commitSettingsJson(newSettings, passphrase);
      clearLocalOverride();
      return { localSaved: true, githubSaved: true };
    } catch (e) {
      console.error("GitHub save failed", e);
      writeLocalOverride(newSettings);
      return { localSaved: true, githubSaved: false, reason: e.message };
    }
  }

  function resetLocalOverride() {
    clearLocalOverride();
    cached = null;
  }

  global.MaynardSettings = { load, getCached, save, resetLocalOverride };
})(window);
