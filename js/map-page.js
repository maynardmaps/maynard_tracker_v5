// map-page.js - bootstraps index.html: builds the map, side panel controls,
// and wires up all overlay modules.
(function () {
  "use strict";

  let settings, manifest, map, secrets;
  let geoVisible = false;

  async function main() {
    secrets = window.MAYNARD_SECRETS || {};
    settings = await MaynardSettings.load();
    manifest = await MaynardUtils.loadRoutesManifest();

    map = MaynardMapCore.init(
      "map",
      settings.startPoint,
      settings.startZoom,
      settings.mapSources,
      secrets
    );

    buildBaseLayerControl();
    buildRouteFolderControl();
    buildWeatherAndMarkerControls();
    buildGeolocationControl();

    await loadRouteFolder(settings.defaultRouteFolder);

    MaynardKmlMarkers.start(map, {
      feedUrl: window.MAYNARD_CONFIG.garminKmlFeedUrl,
      relayUrl: window.MAYNARD_CONFIG.garminRelayUrl,
      gpsvProxyUrl: window.MAYNARD_CONFIG.gpsvProxyUrl,
      proxies: window.MAYNARD_CONFIG.corsProxies,
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
      url: window.MAYNARD_CONFIG.birdsRiversKmlUrl,
      startVisible: settings.birdsRiversEnabledByDefault === true
    });
    const birdsRiversToggle = document.getElementById("toggle-birds-rivers");
    if (birdsRiversToggle) birdsRiversToggle.checked = settings.birdsRiversEnabledByDefault === true;

    fitToEverything();

    // Overlay modules re-attach themselves whenever the map is rebuilt
    // (happens when switching to/from the OS Leisure CRS).
    MaynardMapCore.onMapReady((newMap) => {
      map = newMap;
      MaynardRoutes.attachToMap(map);
      MaynardKmlMarkers.reattach(map);
      MaynardWeather.reattach(map);
      MaynardBirdsRivers.reattach(map);
      if (geoVisible) MaynardGeolocation.reattach(map);
    });
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
        wrapper.innerHTML = `<input type="radio" name="base-layer" id="${id}" ${i === 0 ? "checked" : ""}/> ${source.name}`;
        wrapper.querySelector("input").addEventListener("change", () => {
          MaynardMapCore.setBaseLayer(source, secrets);
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
        row.innerHTML =
          `<input type="checkbox" checked/>` +
          `<span class="colour-swatch" style="background:${entry.colour}"></span>` +
          `<span class="route-name">${filename}</span>`;
        row.querySelector("input").addEventListener("change", (e) => {
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
