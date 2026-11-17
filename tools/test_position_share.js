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
      bindPopup() { return this; },
      addTo() { layers.add(this); return this; },
      setLatLng(next) { this.coords = next; }
    };
  }
};
let positions = [{ sessionId: "other", name: "TT1", latitude: 50, longitude: -4, timestamp: Date.now() }];
let gpsRequests = 0;
let posts = 0;
const pickerEntries = [];
const context = {
  window: { MAYNARD_CONFIG: { garminRelayUrl: "https://relay.example" } },
  document: {
    hidden: false,
    addEventListener() {},
    createElement() { return { set textContent(value) { this.innerHTML = value; }, innerHTML: "" }; }
  },
  navigator: { geolocation: { getCurrentPosition() { gpsRequests++; } } },
  localStorage: { setItem() {} },
  MaynardPollingCoordinator: coordinator,
  MaynardNearbyPicker: { register(_marker, category, label) { pickerEntries.push({ category, label }); } },
  MaynardUtils: { createGpsBackoffTracker: () => ({ getNextRetryDelayMs: () => 300000 }) },
  L: leaflet,
  fetch: async (_url, options) => {
    if (options && options.method === "POST") posts++;
    return { ok: true, json: async () => ({ positions }) };
  },
  setTimeout: () => 1,
  clearTimeout() {},
  console
};
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
  assert.equal(gpsRequests, 0, "viewing positions does not start GPS");
  assert.equal(posts, 0, "viewing positions does not send our position");
  assert.equal(subscriptions.size, 1);
  share.init(map, { positionShare: { persistenceMinutes: 20 } });
  assert.equal(subscriptions.size, 1, "initialization does not duplicate marker polling");

  assert.equal(share.enable("ME"), true);
  assert.equal(subscriptions.size, 2);
  share.disable();
  assert.equal(subscriptions.size, 1, "stopping sharing keeps marker polling active");
  assert.equal(layers.size, 1, "stopping sharing does not hide other markers");
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
  console.log("Position-share viewing tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
