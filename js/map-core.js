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

  const BNG_PROJ4 = MaynardUtils.BNG_PROJ4;
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

  function makeTileLayer(source) {
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
    const options = {
      attribution: source.attribution || "",
      maxNativeZoom: source.maxNativeZoom,
      maxZoom: source.type === "os-27700" ? BNG_MAX_ZOOM : 19,
      crossOrigin: !viaRelay
    };
    if (source.bounds) {
      options.bounds = L.latLngBounds(
        [source.bounds.south, source.bounds.west],
        [source.bounds.north, source.bounds.east]
      );
    }
    return L.tileLayer(url, options);
  }

  // Metres per pixel at a latitude for a Web Mercator zoom.
  function mercatorRes(zoom, lat) {
    return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  }

  // Picks the zoom in the target CRS whose ground scale best matches the
  // current one, so the view looks the same after a CRS switch.
  function convertZoom(zoom, lat, fromCrs, toCrs) {
    if (fromCrs === toCrs) return zoom;
    if (fromCrs === "3857") {
      const res = mercatorRes(zoom, lat);
      let best = 0;
      BNG_RESOLUTIONS.forEach((r, i) => {
        if (Math.abs(Math.log(r / res)) < Math.abs(Math.log(BNG_RESOLUTIONS[best] / res))) best = i;
      });
      return Math.min(best, BNG_MAX_ZOOM);
    }
    const res = BNG_RESOLUTIONS[Math.min(zoom, BNG_RESOLUTIONS.length - 1)];
    return Math.max(0, Math.round(Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / res)));
  }

  function createMap(containerId, center, zoom, crsName) {
    const bng = crsName === "27700";
    const crs = bng ? buildBngCrs() : L.CRS.EPSG3857;
    map = L.map(containerId, {
      center: [center.lat, center.lng],
      zoom: bng ? Math.min(zoom, BNG_MAX_ZOOM) : zoom,
      crs,
      zoomControl: true,
      maxZoom: bng ? BNG_MAX_ZOOM : 19,
      zoomAnimation: !bng,
      markerZoomAnimation: !bng
    });
    currentCrsName = crsName;
    scaleControl = L.control.scale({ imperial: true, metric: true }).addTo(map);
    notifyReady();
    return map;
  }

  function init(containerId, center, zoom, sources) {
    const firstSource = sources.find((s) => s.enabled) || sources[0];
    const crsName = firstSource && firstSource.type === "os-27700" ? "27700" : "3857";
    createMap(containerId, center, zoom, crsName);
    setBaseLayer(firstSource);
    return map;
  }

  // Switches the visible base layer, recreating the map if the new layer
  // needs a different CRS than the one currently in use.
  function setBaseLayer(source) {
    const neededCrs = source.type === "os-27700" ? "27700" : "3857";
    if (neededCrs !== currentCrsName) {
      const center = map.getCenter();
      const zoom = convertZoom(map.getZoom(), center.lat, currentCrsName, neededCrs);
      const containerId = map._container ? map._container.id : "map";
      map.remove();
      createMap(containerId, center, zoom, neededCrs);
    }
    if (baseLayer) {
      map.removeLayer(baseLayer);
    }
    baseLayer = makeTileLayer(source);
    baseLayer.addTo(map);
  }

  global.MaynardMapCore = { init, setBaseLayer, onMapReady };
})(window);
