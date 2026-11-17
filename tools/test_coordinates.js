"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const elements = new Map([
  ["start-lat", { value: "50.54307" }],
  ["start-lng", { value: "-3.84362" }]
]);
function element() {
  return {
    children: [],
    appendChild(child) { this.children.push(child); }
  };
}
const context = {
  window: { MAYNARD_CONFIG: { garminRelayUrl: "https://relay.example" } },
  document: { getElementById: (id) => elements.get(id), createElement: element },
  console
};
vm.runInNewContext(fs.readFileSync("js\\utils.js", "utf8"), context);
context.MaynardUtils = context.window.MaynardUtils;
assert.equal(context.MaynardUtils.formatCoordinate(50.543071), "50.54307");
assert.equal(context.MaynardUtils.formatCoordinate(-3.843616), "-3.84362");

let coordinates = { lat: 50.543071, lng: -3.843616 };
const marker = {
  getLatLng: () => coordinates,
  setLatLng: ([lat, lng]) => { coordinates = { lat, lng }; }
};
const pickerMap = { panTo() {} };
const config = fs.readFileSync("js\\config-page.js", "utf8").replace(
  'document.addEventListener("DOMContentLoaded", main);',
  "globalThis.configTest = { renderLocationHistory, readStartPoint, syncMarkerFromInputs, syncLatLngInputsFromMarker, setPicker(marker, map) { pickerMarker = marker; pickerMap = map; } };"
);
vm.runInNewContext(config, context);
const configTest = context.configTest;
configTest.setPicker(marker, pickerMap);
assert.equal(configTest.readStartPoint().lat, 50.543071, "unchanged settings retain latitude precision");
assert.equal(configTest.readStartPoint().lng, -3.843616, "unchanged settings retain longitude precision");
elements.get("start-lat").value = "50.1234567";
configTest.syncMarkerFromInputs();
assert.equal(coordinates.lat, 50.1234567);
assert.equal(coordinates.lng, -3.843616, "editing latitude preserves longitude precision");
assert.equal(elements.get("start-lat").value, "50.12346");
assert.equal(configTest.readStartPoint().lat, 50.1234567, "edited point retains its full precision");
coordinates = { lat: 51.123456, lng: -4.123456 };
configTest.syncLatLngInputsFromMarker();
assert.equal(elements.get("start-lat").value, "51.12346");
assert.equal(elements.get("start-lng").value, "-4.12346");
assert.equal(configTest.readStartPoint().lng, -4.123456, "map-selected point retains its full precision");

const history = element();
configTest.renderLocationHistory(history, {
  name: "Team", imei: "123", entries: [{
    latitude: 50.543071, longitude: -3.843616, time: Date.now(),
    kind: "position", raw: '{"latitude":50.543071}'
  }]
});
const row = history.children[0].children[1];
assert.match(row.children[0].textContent, /50\.54307, -3\.84362/);
assert.equal(row.children[1].textContent, '{"latitude":50.543071}', "raw diagnostic data stays unchanged");

const nodes = new Map();
const root = {
  querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "" });
    return nodes.get(selector);
  },
  addEventListener() {}
};
context.fetch = async () => ({ json: async () => ({ locations: [
  { imei: "unknown", coordinate: { latitude: 50.543071, longitude: -3.843616 } },
  { imei: "missing" }
] }) });
context.MaynardGithubSave = { ipcCommand: async () => ({ log: [] }) };
context.setInterval = () => 1;
context.clearInterval = () => {};
vm.runInNewContext(fs.readFileSync("js\\messaging-panel.js", "utf8"), context);
const panel = context.window.MaynardMessaging.mount(root, { devices: [], passphrase: () => "" });
panel.refresh().then(() => {
  assert.match(nodes.get(".msg-unregistered").innerHTML, /50\.54307, -3\.84362/);
  assert.match(nodes.get(".msg-unregistered").innerHTML, /No position/);
  panel.destroy();
  console.log("Coordinate display tests passed.");
}).catch((error) => { console.error(error); process.exitCode = 1; });
