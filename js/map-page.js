// map-page.js - bootstraps index.html: builds the map, side panel controls,
// and wires up all overlay modules.
(function () {
  "use strict";

  let settings, manifest, map;
  let geoVisible = false;
  let routeLoadFinished = Promise.resolve();

  let homeMarker = null;

  const DEFAULT_RIVER_BOUNDS = { south: 50.345, west: -4.27, north: 50.795, east: -3.57 };
  function riverLevelSettings() {
    const r = settings.riverLevels || {};
    return { enabledByDefault: r.enabledByDefault === true, bounds: r.bounds || DEFAULT_RIVER_BOUNDS };
  }

  async function main() {
    settings = await MaynardSettings.load();
    MaynardUtils.setDiagnosticsEnabled(settings.diagnosticsEnabled === true);
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
    buildPositionShareControl();

    await loadRouteFolder(document.getElementById("route-folder-select").value);
    MaynardUtils.watchLondonDate(() => {
      if (!settings.autoRouteFolder) return;
      const select = document.getElementById("route-folder-select");
      const selected = autoDefaultFolder();
      if (select.value !== selected) {
        select.value = selected;
        loadRouteFolder(selected).catch(reportRouteLoadError);
      }
    });
    if (settings.eta && settings.eta.enabled) {
      const etaRoutes = await MaynardEta.discoverRoutes(manifest);
      MaynardEta.init(etaRoutes, map, settings);
      MaynardUtils.diag("ETA", etaRoutes.length > 0,
        etaRoutes.length ? `${etaRoutes.length} routes available` : "no route geometries available");
    }

    if (settings.mode === "test") {
      const banner = document.createElement("div");
      banner.id = "test-mode-banner";
      banner.setAttribute("role", "status");
      banner.textContent = "TEST MODE - data on this map may be simulated";
      document.body.appendChild(banner);
    }
    MaynardUtils.diag("Mode", true, settings.mode === "test" ? "TEST mode (unregistered devices and test injection allowed)" : "normal mode");
    MaynardKmlMarkers.start(map, {
      relayUrl: window.MAYNARD_CONFIG.garminRelayUrl,
      pollIntervalMs: window.MAYNARD_CONFIG.garminPollIntervalMs,
      pushPollIntervalMs: window.MAYNARD_CONFIG.garminPushPollIntervalMs,
      palette: settings.markerColours,
      mapDataMaxAgeHours: settings.mapDataMaxAgeHours || 12,
      mode: settings.mode,
      devices: settings.devices || [],
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
    MaynardRiverLevels.init(map, {
      bounds: rl.bounds,
      startVisible: rl.enabledByDefault,
      mapDataMaxAgeHours: settings.mapDataMaxAgeHours || 12,
      mode: settings.mode
    });
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
      if (MaynardEta) MaynardEta.reattach(map);
      MaynardKmlMarkers.reattach(map);
      MaynardWeather.reattach(map);
      MaynardBirdsRivers.reattach(map);
      MaynardRiverLevels.reattach(map);
      MaynardPositionShare.reattach(map);
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
      const navIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2 4.5 21 12 17l7.5 4L12 2Zm0 5.2 4.2 10.1-4.2-2.2-4.2 2.2L12 7.2Z"/></svg>';
      const html = `<div class="kml-popup"><strong>${lat}, ${lng}</strong>` +
        (gr ? `<div class="kml-popup-grid">Grid ref: ${gr}</div>` : "") +
        `<div class="kml-popup-nav"><a href="${MaynardUtils.escapeHtml(href)}" title="Open location in maps" aria-label="Nav to dropped pin in maps" target="_blank" rel="noopener">${navIcon} Nav to</a></div></div>`;
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
      .sort(MaynardUtils.compareRouteFolders)
      .forEach((folder) => {
        const opt = document.createElement("option");
        opt.value = folder;
        opt.textContent = folder;
        select.appendChild(opt);
      });
    select.value = autoDefaultFolder();
    select.addEventListener("change", () => loadRouteFolder(select.value).catch(reportRouteLoadError));
  }

  function autoDefaultFolder() {
    const folders = Object.keys(manifest.folders).sort(MaynardUtils.compareRouteFolders);
    const manual = folders.includes(settings.defaultRouteFolder) ? settings.defaultRouteFolder : (folders[0] || "");
    const automatic = settings.autoRouteFolder ? MaynardUtils.autoRouteFolder(folders, settings.routeFolderDates || {}) : null;
    MaynardUtils.setStatus("auto-route", settings.autoRouteFolder && !automatic
      ? "No dated route folders; using the manual default" : "");
    return automatic || manual;
  }

  function reportRouteLoadError(err) {
    console.error("Route folder load failed", err);
    MaynardUtils.setStatus("routes", "Route folder could not be loaded");
  }

  async function loadRouteFolder(folder) {
    const previous = routeLoadFinished;
    let release;
    routeLoadFinished = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      MaynardRoutes.detachFromMap(map);
      await MaynardRoutes.loadFolder(folder, manifest, settings.routeColours);
      MaynardRoutes.attachToMap(map);
      buildRouteToggleList();
      fitToEverything();
      MaynardUtils.setStatus("routes", "");
    } finally {
      release();
    }
  }

  function buildRouteToggleList() {
    const container = document.getElementById("route-toggle-list");
    container.innerHTML = "";
    const layers = MaynardRoutes.getLayers();
    [...layers.keys()]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((filename) => {
        const entry = layers.get(filename);
        const row = document.createElement("div");
        row.className = "route-row";
        const main = document.createElement("label");
        main.className = "route-row-main";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        const swatch = document.createElement("span");
        swatch.className = "colour-swatch";
        swatch.style.background = entry.colour;
        const name = document.createElement("span");
        name.className = "route-name";
        name.textContent = filename;
        main.append(cb, swatch, name);
        cb.addEventListener("change", (e) => {
          MaynardRoutes.setVisible(filename, e.target.checked, map);
        });
        row.appendChild(main);
        if (entry.pointLayers.length) {
          const labelToggle = document.createElement("label");
          labelToggle.className = "route-label-toggle";
          const labelCheckbox = document.createElement("input");
          labelCheckbox.type = "checkbox";
          labelCheckbox.checked = entry.pointLabelsVisible;
          labelCheckbox.setAttribute("aria-label", `Show ${filename} point labels`);
          labelToggle.append(labelCheckbox, " Labels");
          labelCheckbox.addEventListener("change", (e) => {
            MaynardRoutes.setLabelsVisible(filename, e.target.checked);
          });
          row.appendChild(labelToggle);
        }
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

  function buildPositionShareControl() {
    MaynardPositionShare.init(map, settings);
    const nameBox = document.getElementById("position-share-name-box");
    const nameInput = document.getElementById("position-share-name");
    const submitBtn = document.getElementById("position-share-submit");
    const stateEl = document.getElementById("position-share-state");
    const statusEl = document.getElementById("position-share-status");
    let statusKind = "";
    let statusTimer = null;

    function renderSharingState() {
      const active = MaynardPositionShare.isEnabled();
      nameBox.hidden = active;
      stateEl.textContent = active ? `Sharing as ${nameInput.value.trim()}` : "Not sharing";
      submitBtn.textContent = active ? "Stop sharing" : "Start sharing";
      if (!active && statusTimer !== null) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
    }

    MaynardPositionShare.setStatusCallback((statusInfo) => {
      statusKind = statusInfo.status;
      statusEl.textContent = statusInfo.message;
      statusEl.className = `status-msg ${statusInfo.status}`;
      renderSharingState();
    });
    nameInput.value = MaynardPositionShare.loadDisplayName();
    renderSharingState();

    submitBtn.addEventListener("click", () => {
      if (MaynardPositionShare.isEnabled()) {
        MaynardPositionShare.disable();
        return;
      }
      const name = nameInput.value.trim();
      if (!name) {
        statusEl.textContent = "Please enter a name (up to 4 characters).";
        statusEl.className = "status-msg error";
        return;
      }
      if (name.length > 4 || !/^[A-Za-z0-9\-. ]+$/.test(name)) {
        statusEl.textContent = "Use up to 4 letters, numbers, spaces, dots or dashes.";
        statusEl.className = "status-msg error";
        return;
      }

      statusKind = "pending";
      statusEl.textContent = "Requesting GPS location...";
      statusEl.className = "status-msg pending";
      const success = MaynardPositionShare.enable(name);
      if (success) {
        renderSharingState();
        statusTimer = setInterval(() => {
          if (statusKind === "ok" && MaynardPositionShare.isEnabled()) {
            statusEl.textContent = MaynardPositionShare.getLastShareStatus().message;
          }
        }, 10000);
      } else {
        if (statusKind !== "error") {
          statusEl.textContent = "Geolocation is unavailable.";
          statusEl.className = "status-msg error";
        }
      }
    });

    // Allow Enter key to submit
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitBtn.click();
      }
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
