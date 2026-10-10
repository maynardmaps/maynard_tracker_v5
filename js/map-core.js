// map-core.js - Leaflet map lifecycle, base layers, and CRS switching.
//
// Background: the OS Maps API "Leisure_27700" raster layer is published in
// British National Grid (EPSG:27700), while OSM / Esri tiles use Web
// Mercator (EPSG:3857). A single Leaflet map instance can only use one CRS,
// so switching to/from the OS layer destroys and recreates the Leaflet map
// with the matching CRS, preserving the current view. Overlay modules
// (routes, markers, weather, geolocation) re-attach themselves via the
// "mapReady" hook below whenever that happens.
(function (global) {
  "use strict";

  // EPSG:27700 (British National Grid) definition for Proj4Leaflet.
  const BNG_PROJ4 =
    "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
    "+ellps=airy +datum=OSGB36 +units=m +no_defs";
  const BNG_RESOLUTIONS = [896.0, 448.0, 224.0, 112.0, 56.0, 28.0, 14.0, 7.0, 3.5, 1.75, 0.875, 0.4375];
  // The OS Maps API "Leisure_27700" tile endpoint only serves zoom levels 0-9
  // (confirmed empirically: z>=10 returns HTTP 400), even though the tile
  // matrix set above defines resolutions down to zoom 11.
  const BNG_MAX_ZOOM = 9;

  let map = null;
  let currentCrsName = null; // "3857" | "27700"
  let baseLayer = null;
  let scaleControl = null;
  const readyListeners = [];

  function onMapReady(cb) {
    readyListeners.push(cb);
    if (map) cb(map);
  }

  function notifyReady() {
    readyListeners.forEach((cb) => {
      try {
        cb(map);
      } catch (e) {
        console.error("mapReady listener failed", e);
      }
    });
  }

  function buildBngCrs() {
    return new L.Proj.CRS("EPSG:27700", BNG_PROJ4, {
      resolutions: BNG_RESOLUTIONS,
      origin: [-238375.0, 1376256.0]
    });
  }

  function makeTileLayer(source, secrets) {
    let url = source.url;
    let viaRelay = false;
    if (source.requiresKey) {
      const relay = window.MAYNARD_CONFIG && window.MAYNARD_CONFIG.garminRelayUrl;
      const osPrefix = "https://api.os.uk/maps/raster/v1/zxy/";
      if (relay && url.startsWith(osPrefix)) {
        url = relay.replace(/\/$/, "") + "/os/" + url.slice(osPrefix.length);
        viaRelay = true;
      } else {
        console.warn(`Map source "${source.id}" requires a key but no relay is available.`);
      }
    }
    return L.tileLayer(url, {
      attribution: source.attribution || "",
      maxZoom: source.type === "os-27700" ? BNG_MAX_ZOOM : 19,
      crossOrigin: !viaRelay
    });
  }

  function createMap(containerId, center, zoom, crsName) {
    const crs = crsName === "27700" ? buildBngCrs() : L.CRS.EPSG3857;
    map = L.map(containerId, {
      center: [center.lat, center.lng],
      zoom: crsName === "27700" ? Math.min(zoom, BNG_MAX_ZOOM) : zoom,
      crs,
      zoomControl: true
    });
    currentCrsName = crsName;
    scaleControl = L.control.scale({ imperial: true, metric: true }).addTo(map);
    notifyReady();
    return map;
  }

  function init(containerId, center, zoom, sources, secrets) {
    const firstSource = sources.find((s) => s.enabled) || sources[0];
    const crsName = firstSource && firstSource.type === "os-27700" ? "27700" : "3857";
    createMap(containerId, center, zoom, crsName);
    setBaseLayer(firstSource, secrets);
    return map;
  }

  // Switches the visible base layer, recreating the map if the new layer
  // needs a different CRS than the one currently in use.
  function setBaseLayer(source, secrets) {
    const neededCrs = source.type === "os-27700" ? "27700" : "3857";
    if (neededCrs !== currentCrsName) {
      const center = map.getCenter();
      const zoom = map.getZoom();
      const containerId = map._container ? map._container.id : "map";
      map.remove();
      createMap(containerId, center, zoom, neededCrs);
    }
    if (baseLayer) {
      map.removeLayer(baseLayer);
    }
    baseLayer = makeTileLayer(source, secrets);
    baseLayer.addTo(map);
  }

  function getMap() {
    return map;
  }

  function getCrsName() {
    return currentCrsName;
  }

  global.MaynardMapCore = { init, setBaseLayer, getMap, getCrsName, onMapReady };
})(window);
