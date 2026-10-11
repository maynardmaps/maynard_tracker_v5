// app-config.js
// Non-secret, committable configuration. Edit freely.
window.MAYNARD_CONFIG = {
  // GitHub repo that this site is deployed from, used by:
  //  - the config page's "View on GitHub" link
  //  - the "Save settings" button (commits settings.json via Contents API)
  // These are just the fallback defaults - they can be overridden from the
  // configuration page (stored in settings.json / localStorage) without
  // editing this file.
  github: {
    owner: "maynardmaps",
    repo: "maynard_tracker_v5",
    branch: "main"
  },

  // URL of your deployed Cloudflare Worker relay (see worker/ and README).
  // Source of the Garmin feed, Met Office weather and OS tiles.
  // Leave empty until the worker is deployed, e.g.
  // "https://maynard-garmin-relay.<your-subdomain>.workers.dev"
  garminRelayUrl: "https://maynard-garmin-relay.maynardmaps.workers.dev",

  // How often to re-poll the Garmin feed and Met Office image for
  // "real-time" updates, in milliseconds.
  garminPollIntervalMs: 60000,
  weatherPollIntervalMs: 300000,

  // Manifest describing the routes/ folder tree (GitHub Pages can't list
  // directories, so this file must be kept in sync with routes/ contents -
  // see routes/manifest.json and the README for how to update it).
  routesManifestUrl: "routes/manifest.json",

  // Static "birds and rivers" KML file (points + polygons) - loaded once,
  // not polled, since it's a version-controlled static file.
  birdsRiversKmlUrl: "data/birdsrivers.kml",

  // Default settings shipped with the repo (overridden by settings.json if
  // present, and then by the config page / localStorage).
  defaultSettingsUrl: "settings.json",

  // Approximate bounding box used to place the Met Office precipitation PNG
  // overlay (UK preset region, equirectangular). Adjust in config.html if the
  // overlay looks mis-aligned against your base map.
  metOfficeUkBounds: {
    south: 48.0,
    west: -11.0,
    north: 61.0,
    east: 2.5
  }
};
