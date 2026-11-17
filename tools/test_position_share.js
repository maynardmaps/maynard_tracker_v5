"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const subscriptions = new Map();
let nextId = 0;
const coordinator = {
  subscribe(callback, interval) {
    const id = nextId++;
    subscriptions.set(id, { callback, interval });
    callback();
    return id;
  },
  unsubscribe(id) { subscriptions.delete(id); },
  updateInterval() {}
};
const layers = new Set();
const group = {
  addTo(map) { map.layers.add(this); return this; },
  removeLayer(marker) { layers.delete(marker); }
};
const map = { layers: new Set(), hasLayer(layer) { return this.layers.has(layer); } };
const leaflet = {
  featureGroup: () => group,
  divIcon: (options) => options,
  marker(coords, options) {
    return {
      coords, options,
      bindPopup(content) { this.popup = content; return this; },
      setPopupContent(content) { this.popup = content; return this; },
      addTo() { layers.add(this); return this; },
      setLatLng(next) { this.coords = next; }
    };
  }
};
let positions = [{ sessionId: "other", name: "TT1", latitude: 50, longitude: -4, accuracy: 12.3, timestamp: Date.now() }];
let gpsRequests = 0;
let posts = 0;
let gpsSuccess;
let lastPost;
const pickerEntries = [];
const storage = new Map();
const context = {
  window: {
    MAYNARD_CONFIG: { garminRelayUrl: "https://relay.example" },
    crypto: { getRandomValues(bytes) { bytes.fill(42); return bytes; } },
    addEventListener() {}
  },
  document: {
    hidden: false,
    addEventListener() {},
    createElement() { return { set textContent(value) { this.innerHTML = value; }, innerHTML: "" }; }
  },
  navigator: { geolocation: { getCurrentPosition(success) { gpsRequests++; gpsSuccess = success; } } },
  localStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); } },
  MaynardPollingCoordinator: coordinator,
  MaynardNearbyPicker: { register(_marker, category, label) { pickerEntries.push({ category, label }); } },
  MaynardConnectionMonitor: { recordAttempt() {} },
  L: leaflet,
  fetch: async (_url, options) => {
    if (options && options.method === "POST") {
      posts++;
      lastPost = JSON.parse(options.body);
      return { ok: true, json: async () => ({ sessionId: "ours" }) };
    }
    return { ok: true, json: async () => ({ positions }) };
  },
  setTimeout: () => 1,
  clearTimeout() {},
  console
};
vm.runInNewContext(fs.readFileSync("js/utils.js", "utf8"), context);
context.MaynardUtils = context.window.MaynardUtils;
context.MaynardUtils.createGpsBackoffTracker = () => ({ getNextRetryDelayMs: () => 300000, recordSuccess() {} });
vm.runInNewContext(fs.readFileSync("js/kml-markers.js", "utf8"), context);
context.MaynardKmlMarkers = context.window.MaynardKmlMarkers;
context.MaynardKmlMarkers.gridRef = (lat) => lat === 50 ? "SX 123 456" : null;
vm.runInNewContext(fs.readFileSync("js/position-share.js", "utf8"), context);
const share = context.window.MaynardPositionShare;
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  share.init(map, { positionShare: { persistenceMinutes: 20 } });
  await settle();
  assert.equal(layers.size, 1, "other people's positions appear without sharing");
  const marker = [...layers][0];
  assert.deepEqual(Array.from(marker.options.icon.iconAnchor), [15, 15]);
  assert.deepEqual(Array.from(marker.options.icon.popupAnchor), [0, -15]);
  assert.deepEqual(pickerEntries[0], { category: "Shared position", label: "TT1" });
  assert.match(marker.popup, /Grid ref: SX 123 456/);
  assert.match(marker.popup, /Accuracy: 13 m/);
  assert.doesNotMatch(marker.popup, /Location:/);
  assert.match(marker.popup, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=50,-4"/);
  assert.match(marker.popup, /aria-label="Nav to TT1 in maps"/);
  assert.match(marker.popup, /<svg aria-hidden="true"/);
  assert.match(marker.popup, /target="_blank" rel="noopener"/);
  assert.equal(gpsRequests, 0, "viewing positions does not start GPS");
  assert.equal(posts, 0, "viewing positions does not send our position");
  assert.equal(subscriptions.size, 1);
  share.init(map, { positionShare: { persistenceMinutes: 20 } });
  assert.equal(subscriptions.size, 1, "initialization does not duplicate marker polling");

  assert.equal(share.enable("ME"), true);
  assert.equal(subscriptions.size, 2);
  assert.equal(gpsRequests, 1, "sharing starts one GPS request");
  gpsSuccess({ coords: { latitude: 50, longitude: -4, accuracy: 7.8 } });
  await settle();
  assert.equal(lastPost.accuracy, 7.8, "GPS accuracy is sent without rounding");
  assert.equal(lastPost.sessionId, "2a".repeat(16));
  share.disable();
  assert.equal(subscriptions.size, 1, "stopping sharing keeps marker polling active");
  assert.equal(layers.size, 1, "stopping sharing does not hide other markers");
  positions = [{ ...positions[0], latitude: 40, longitude: -73, accuracy: 0 }];
  context.navigator.userAgent = "Android";
  [...subscriptions.values()][0].callback();
  await settle();
  assert.equal([...layers][0], marker);
  assert.match(marker.popup, /Location: 40\.00000, -73\.00000/);
  assert.match(marker.popup, /Accuracy: 0 m/);
  assert.match(marker.popup, /href="geo:40,-73\?q=40,-73\(TT1\)"/);
  assert.doesNotMatch(marker.popup, /Grid ref:/);
  context.navigator.userAgent = "iPhone";
  [...subscriptions.values()][0].callback();
  await settle();
  assert.match(marker.popup, /href="https:\/\/maps\.apple\.com\/\?ll=40,-73&amp;q=TT1"/);
  delete positions[0].accuracy;
  [...subscriptions.values()][0].callback();
  await settle();
  assert.match(marker.popup, /Accuracy: unavailable/);
  positions = [{ ...positions[0], timestamp: Date.now() - 21 * 60000 }];
  [...subscriptions.values()][0].callback();
  await settle();
  assert.equal(layers.size, 0, "expired positions are removed even if returned by the server");
  positions = [{ sessionId: "new", name: "TT2", latitude: 51, longitude: -3, timestamp: Date.now() }];
  [...subscriptions.values()][0].callback();
  await settle();
  assert.equal(layers.size, 1, "new positions still appear after sharing is disabled");
  const replacementMap = { layers: new Set(), hasLayer(layer) { return this.layers.has(layer); } };
  share.reattach(replacementMap);
  assert.equal(replacementMap.hasLayer(group), true, "positions reattach after a map change");
  let status;
  share.setStatusCallback((next) => { status = next; });
  context.localStorage.getItem = () => { throw new Error("storage unavailable"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(share.enable("ME"), false);
  } finally {
    console.error = originalError;
  }
  assert.equal(status.status, "error");
  assert.match(status.message, /browser storage/);
  assert.equal(share.isEnabled(), false);
  console.log("Position-share viewing tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
