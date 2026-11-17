"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const watches = [];
const cleared = [];
const navigator = {
  geolocation: {
    watchPosition(success, failure) { watches.push({ success, failure }); return watches.length; },
    clearWatch(id) { cleared.push(id); }
  }
};
function makeMap() {
  return {
    layers: new Set(),
    controls: new Set(),
    pans: [],
    hasLayer(layer) { return this.layers.has(layer); },
    removeLayer(layer) { this.layers.delete(layer); },
    panTo(latlng) { this.pans.push(latlng); }
  };
}
const L = {
  control() {
    return {
      addTo(map) {
        this.remove();
        this.map = map;
        this.element = this.onAdd(map);
        map.controls.add(this);
        return this;
      },
      remove() {
        if (this.map) this.map.controls.delete(this);
        this.map = null;
      }
    };
  },
  DomUtil: {
    create(tag, className, parent) {
      const el = { tag, className, children: [], setAttribute(key, value) { this[key] = value; }, addEventListener(_type, fn) { this.click = fn; } };
      if (parent) parent.children.push(el);
      return el;
    }
  },
  DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} },
  divIcon: (options) => options,
  marker(latlng) { return layer(latlng); },
  circle(latlng) { return layer(latlng); }
};
function layer(latlng) {
  const arrow = { hidden: true, style: {} };
  return {
    latlng,
    arrow,
    addTo(map) { map.layers.add(this); return this; },
    getLatLng() { return this.latlng; },
    getElement() { return { querySelector() { return arrow; } }; },
    setLatLng(next) { this.latlng = next; return this; },
    setRadius() { return this; }
  };
}
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { if (listeners.has(type)) listeners.get(type).delete(fn); },
    dispatch(type, data = {}) { for (const fn of listeners.get(type) || []) fn({ ...data, type }); },
    count(type) { return listeners.get(type)?.size || 0; }
  };
}
const screenOrientation = Object.assign(eventTarget(), { angle: 0 });
const window = Object.assign(eventTarget(), { screen: { orientation: screenOrientation }, DeviceOrientationEvent: function () {} });
const context = { window, navigator, L, MaynardUtils: { diag() {} }, console };
vm.runInNewContext(fs.readFileSync("js/geolocation.js", "utf8"), context);
const geo = context.window.MaynardGeolocation;
const firstMap = makeMap();
const secondMap = makeMap();
const button = (map) => [...map.controls][0].element.children[0];
const fix = (lat, lng, heading = null) => ({ coords: { latitude: lat, longitude: lng, accuracy: 10, heading } });

geo.start(firstMap);
assert.equal(button(firstMap).disabled, true, "button waits for a fix");
geo.reattach(secondMap);
assert.equal(firstMap.controls.size, 0, "control leaves old map when CRS changes");
assert.equal(button(secondMap).disabled, true, "control still waits for a fix after CRS change");
watches[0].success(fix(50, -4));
assert.equal(secondMap.layers.size, 2, "first fix attaches to the current map");
assert.equal(button(secondMap).disabled, false);
const arrow = [...secondMap.layers][0].arrow;
assert.equal(arrow.hidden, true, "arrow is hidden without a heading");
watches[0].success(fix(50, -4, 70));
assert.equal(arrow.style.transform, "rotate(70deg)", "GPS course is used without a compass");
window.dispatch("deviceorientation", { absolute: true, alpha: 90, beta: 0, gamma: 0 });
assert.equal(arrow.style.transform, "rotate(270deg)", "absolute compass takes precedence");
screenOrientation.angle = 90;
screenOrientation.dispatch("change");
assert.equal(arrow.style.transform, "rotate(0deg)", "landscape screen rotation updates compass");
screenOrientation.angle = 270;
screenOrientation.dispatch("change");
assert.equal(arrow.style.transform, "rotate(180deg)", "opposite landscape rotation updates compass");
screenOrientation.angle = 90;
screenOrientation.dispatch("change");
window.dispatch("deviceorientation", { absolute: false, alpha: 45, beta: 0, gamma: 0 });
assert.equal(arrow.style.transform, "rotate(0deg)", "relative orientation is not a compass");
window.dispatch("deviceorientationabsolute", { alpha: 0, beta: 30, gamma: 30 });
assert.ok(Math.abs(parseFloat(arrow.style.transform.slice(7)) - 73.897886) < 0.001, "tilt is included in projected landscape heading");
window.dispatch("deviceorientation", { webkitCompassHeading: 80 });
assert.equal(arrow.style.transform, "rotate(170deg)", "WebKit compass accounts for screen rotation");
screenOrientation.angle = 0;
screenOrientation.dispatch("change");
assert.equal(arrow.style.transform, "rotate(80deg)", "portrait screen rotation updates compass");
window.dispatch("deviceorientation", { absolute: true, alpha: 0, beta: 90, gamma: 0 });
assert.equal(arrow.style.transform, "rotate(70deg)", "vertical screen top falls back to GPS course");
watches[0].success(fix(50, -4));
assert.equal(arrow.hidden, true, "arrow hides when neither direction is usable");
button(secondMap).click();
assert.deepEqual(Array.from(secondMap.pans[0]), [50, -4]);
watches[0].success(fix(51, -3));
button(secondMap).click();
assert.deepEqual(Array.from(secondMap.pans[1]), [51, -3], "button uses latest location");
geo.stop(secondMap);
assert.equal(secondMap.controls.size, 0);
assert.equal(secondMap.layers.size, 0);
assert.deepEqual(cleared, [1]);
assert.equal(window.count("deviceorientation"), 0, "sensor listeners stop with location");
assert.equal(screenOrientation.count("change"), 0);
geo.start(firstMap);
watches[0].success(fix(52, -2));
assert.equal(button(firstMap).disabled, true, "late callbacks from an old watch are ignored");
watches[1].success(fix(53, -1));
assert.equal(button(firstMap).disabled, false);
geo.stop(firstMap);

(async () => {
  let grantPermission;
  window.DeviceOrientationEvent.requestPermission = () => new Promise((resolve) => { grantPermission = resolve; });
  geo.start(firstMap);
  geo.stop(firstMap);
  grantPermission("granted");
  await Promise.resolve();
  assert.equal(window.count("deviceorientation"), 0, "a late permission grant cannot restart a stopped listener");
  console.log("Geolocation control and heading tests passed.");
})().catch((err) => { console.error(err); process.exitCode = 1; });
