// map-page.js - bootstraps index.html: builds the map, side panel controls,
// and wires up all overlay modules.
(function () {
  "use strict";

  let settings, manifest, map;
  let geoVisible = false;

  let homeMarker = null;

  const DEFAULT_RIVER_BOUNDS = { south: 50.345, west: -4.27, north: 50.795, east: -3.57 };
  function riverLevelSettings() {
    const r = settings.riverLevels || {};
    return { enabledByDefault: r.enabledByDefault === true, bounds: r.bounds || DEFAULT_RIVER_BOUNDS };
  }

  async function main() {
    settings = await MaynardSettings.load();
    manifest = await MaynardUtils.loadRoutesManifest();

    map = MaynardMapCore.init(
      "map",
      settings.startPoint,
      settings.startZoom,
      settings.mapSources
    );

    buildBaseLayerControl();
    buildRouteFolderControl();
    buildWeatherAndMarkerControls();
    buildGeolocationControl();

    await loadRouteFolder(settings.defaultRouteFolder);

    MaynardKmlMarkers.start(map, {
      relayUrl: window.MAYNARD_CONFIG.garminRelayUrl,
      pollIntervalMs: window.MAYNARD_CONFIG.garminPollIntervalMs,
      palette: settings.markerColours,
      startVisible: true
    });

    MaynardWeather.start(map, {
      relayUrl: window.MAYNARD_CONFIG.garminRelayUrl,
      pollIntervalMs: window.MAYNARD_CONFIG.weatherPollIntervalMs,
      bounds: window.MAYNARD_CONFIG.metOfficeUkBounds,
      startVisible: settings.weatherEnabledByDefault === true
    });
    const weatherToggle = document.getElementById("toggle-weather");
    if (weatherToggle) weatherToggle.checked = settings.weatherEnabledByDefault === true;

    await MaynardBirdsRivers.init(map, {
      urls: (manifest.data || []).map((f) => "data/" + encodeURIComponent(f)),
      startVisible: settings.birdsRiversEnabledByDefault === true
    });
    const birdsRiversToggle = document.getElementById("toggle-birds-rivers");
    if (birdsRiversToggle) birdsRiversToggle.checked = settings.birdsRiversEnabledByDefault === true;

    const rl = riverLevelSettings();
    MaynardRiverLevels.init(map, { bounds: rl.bounds, startVisible: rl.enabledByDefault });
    const riverToggle = document.getElementById("toggle-river-levels");
    if (riverToggle) riverToggle.checked = rl.enabledByDefault;

    addHomeMarker();
    enableLocationMenu();
    fitToEverything();

    // Overlay modules re-attach themselves whenever the map is rebuilt
    // (happens when switching to/from the OS Leisure CRS).
    MaynardMapCore.onMapReady((newMap) => {
      map = newMap;
      MaynardRoutes.attachToMap(map);
      MaynardKmlMarkers.reattach(map);
      MaynardWeather.reattach(map);
      MaynardBirdsRivers.reattach(map);
      MaynardRiverLevels.reattach(map);
      addHomeMarker();
      enableLocationMenu();
      if (geoVisible) MaynardGeolocation.reattach(map);
    });
  }

  // Right-click (desktop) or long-press (touch) opens a popup with the point's
  // coordinates and a button to open it in the phone's maps app.
  function enableLocationMenu() {
    if (map._locMenu) return;
    map._locMenu = true;
    map.on("contextmenu", (e) => {
      const lat = e.latlng.lat.toFixed(6);
      const lng = e.latlng.lng.toFixed(6);
      const href = MaynardKmlMarkers.mapAppUrl(lat, lng, "Dropped pin");
      const gr = MaynardKmlMarkers.gridRef(e.latlng.lat, e.latlng.lng);
      const html = `<div class="kml-popup"><strong>${lat}, ${lng}</strong>` +
        (gr ? `<div class="kml-popup-grid">Grid ref: ${gr}</div>` : "") +
        `<div class="kml-popup-map"><a href="${MaynardUtils.escapeHtml(href)}" title="Open in maps app" aria-label="Open in maps app" target="_blank" rel="noopener">&#128506; Map</a></div></div>`;
      L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
    });
  }

  function addHomeMarker() {
    if (homeMarker) homeMarker.remove();
    const p = settings.startPoint;
    homeMarker = L.marker([p.lat, p.lng], {
      title: "Start point",
      icon: L.divIcon({ className: "home-icon", html: "&#127968;", iconSize: [24, 24], iconAnchor: [12, 12] })
    }).addTo(map);
  }

  function buildBaseLayerControl() {
    const container = document.getElementById("base-layer-list");
    container.innerHTML = "";
    settings.mapSources
      .filter((s) => s.enabled)
      .forEach((source, i) => {
        const id = `base-${source.id}`;
        const wrapper = document.createElement("label");
        wrapper.className = "radio-row";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "base-layer";
        radio.id = id;
        radio.checked = i === 0;
        wrapper.append(radio, " " + source.name);
        radio.addEventListener("change", () => {
          MaynardMapCore.setBaseLayer(source);
        });
        container.appendChild(wrapper);
      });
  }

  function buildRouteFolderControl() {
    const select = document.getElementById("route-folder-select");
    select.innerHTML = "";
    Object.keys(manifest.folders)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((folder) => {
        const opt = document.createElement("option");
        opt.value = folder;
        opt.textContent = folder;
        if (folder === settings.defaultRouteFolder) opt.selected = true;
        select.appendChild(opt);
      });
    select.addEventListener("change", () => loadRouteFolder(select.value));
  }

  async function loadRouteFolder(folder) {
    MaynardRoutes.detachFromMap(map);
    await MaynardRoutes.loadFolder(folder, manifest, settings.routeColours);
    MaynardRoutes.attachToMap(map);
    buildRouteToggleList();
    fitToEverything();
  }

  function buildRouteToggleList() {
    const container = document.getElementById("route-toggle-list");
    container.innerHTML = "";
    const layers = MaynardRoutes.getLayers();
    [...layers.keys()]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((filename) => {
        const entry = layers.get(filename);
        const row = document.createElement("label");
        row.className = "route-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        const swatch = document.createElement("span");
        swatch.className = "colour-swatch";
        swatch.style.background = entry.colour;
        const name = document.createElement("span");
        name.className = "route-name";
        name.textContent = filename;
        row.append(cb, swatch, name);
        cb.addEventListener("change", (e) => {
          MaynardRoutes.setVisible(filename, e.target.checked, map);
        });
        container.appendChild(row);
      });
  }

  function buildWeatherAndMarkerControls() {
    document.getElementById("toggle-kml-markers").addEventListener("change", (e) => {
      MaynardKmlMarkers.setVisible(e.target.checked, map);
    });
    document.getElementById("toggle-weather").addEventListener("change", (e) => {
      MaynardWeather.setVisible(e.target.checked, map);
    });
    document.getElementById("toggle-birds-rivers").addEventListener("change", (e) => {
      MaynardBirdsRivers.setVisible(e.target.checked, map);
    });
    document.getElementById("toggle-river-levels").addEventListener("change", (e) => {
      MaynardRiverLevels.setVisible(e.target.checked, map);
    });
  }

  function buildGeolocationControl() {
    document.getElementById("toggle-my-location").addEventListener("change", (e) => {
      geoVisible = e.target.checked;
      if (geoVisible) MaynardGeolocation.start(map);
      else MaynardGeolocation.stop(map);
    });
  }

  function fitToEverything() {
    let bounds = MaynardRoutes.getBounds();
    const markerBounds = MaynardKmlMarkers.getBounds();
    if (markerBounds) {
      bounds = bounds ? bounds.extend(markerBounds) : markerBounds;
    }
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  document.addEventListener("DOMContentLoaded", main);
})();
