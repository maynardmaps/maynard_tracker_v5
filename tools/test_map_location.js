"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const elements = new Map();
const document = {
  addEventListener(type, callback) { if (type === "DOMContentLoaded") this.ready = callback; },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: "", addEventListener() {}, appendChild() {} });
    return elements.get(id);
  },
  createElement() { return { addEventListener() {}, appendChild() {} }; }
};
const map = {
  on(type, callback) { this[type] = callback; },
  hasLayer() { return false; }
};
let activePopup;
const popups = [];
const L = {
  marker() { return { addTo() { return this; } }; },
  divIcon: (options) => options,
  popup() {
    const popup = {
      setLatLng(latlng) { this.latlng = latlng; return this; },
      setContent(content) { this.content = content; return this; },
      openOn() {
        if (activePopup) activePopup.open = false;
        this.open = true;
        activePopup = this;
        return this;
      },
      isOpen() { return this.open; }
    };
    popups.push(popup);
    return popup;
  }
};
const requests = [];
let navigationCoordinates;
let height = 123.6;
const terrain = {
  load() {
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  },
  sample() { return height; }
};
const settings = {
  defaultRouteFolder: "", startPoint: { lat: 50, lng: -4 }, startZoom: 10,
  mapSources: [], routeColours: [], markerColours: [], eta: { enabled: false }
};
const noOp = () => {};
const context = {
  document, L, console: { error: noOp },
  window: { MAYNARD_CONFIG: {} },
  MaynardSettings: { load: async () => settings },
  MaynardUtils: {
    setDiagnosticsEnabled: noOp, loadRoutesManifest: async () => ({ folders: {}, data: [] }),
    compareRouteFolders: noOp, setStatus: noOp, watchLondonDate: noOp, diag: noOp,
    escapeHtml: (value) => value, formatCoordinate: (value) => value.toFixed(5)
  },
  MaynardMapCore: { init: () => map, onMapReady: noOp },
  MaynardRoutes: { detachFromMap: noOp, loadFolder: async () => {}, attachToMap: noOp, getLayers: () => new Map(), getBounds: () => null },
  MaynardPositionShare: { init: noOp, setStatusCallback: noOp, loadDisplayName: () => "", isEnabled: () => false },
  MaynardKmlMarkers: {
    start: noOp, getBounds: () => null,
    mapAppUrl: (lat, lng) => { navigationCoordinates = [lat, lng]; return "https://maps.example"; },
    gridRef: () => "SX 123 456"
  },
  MaynardWeather: { start: noOp },
  MaynardBirdsRivers: { init: async () => {} },
  MaynardRiverLevels: { init: noOp },
  MaynardEtaTerrain: terrain
};
vm.runInNewContext(fs.readFileSync("js/map-page.js", "utf8"), context);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const select = (lat, lng) => map.contextmenu({ latlng: { lat, lng } });

(async () => {
  await document.ready();
  select(50.543071, -3.843616);
  assert.match(popups[0].content, /50\.54307, -3\.84362/);
  assert.deepEqual(navigationCoordinates, [50.543071, -3.843616], "navigation retains the selected point");
  assert.match(popups[0].content, /SX 123 456/);
  assert.match(popups[0].content, /Nav to/);
  assert.match(popups[0].content, /Elevation: loading/);
  assert.match(popups[0].content, /Grid ref: SX 123 456<\/div><div>Elevation: loading\.\.\.<\/div><div class="kml-popup-nav">/);
  requests[0].resolve();
  await tick();
  assert.match(popups[0].content, /Elevation: 124 m/, "terrain is shown with ETA disabled");
  assert.match(popups[0].content, /Grid ref: SX 123 456<\/div><div>Elevation: 124 m<\/div><div class="kml-popup-nav">/);

  select(50.6, -4);
  select(50.7, -4);
  requests[1].resolve();
  await tick();
  assert.match(popups[1].content, /Elevation: loading/, "a closed popup is not updated");
  height = null;
  requests[2].resolve();
  await tick();
  assert.doesNotMatch(popups[2].content, /Elevation/, "outside terrain coverage has no elevation");
  assert.match(popups[2].content, /Nav to/);

  select(50.8, -4);
  requests[3].reject(new Error("network error"));
  await tick();
  assert.match(popups[3].content, /Elevation unavailable/);
  assert.match(popups[3].content, /Grid ref: SX 123 456<\/div><div>Elevation unavailable<\/div><div class="kml-popup-nav">/);
  console.log("Dropped-pin elevation tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
