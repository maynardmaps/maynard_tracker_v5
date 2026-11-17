"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const width = 2340;
const pixels = new Uint8ClampedArray(width * width * 4);
pixels.fill(255);
function setHeight(col, row, height) {
  const value = height * 10 + 10000;
  const offset = (row * width + col) * 4;
  pixels[offset] = value >> 8;
  pixels[offset + 1] = value & 255;
}
setHeight(10, 20, 100);
setHeight(11, 20, 110);
setHeight(10, 21, 120);
setHeight(11, 21, 130);
class FakeImage {
  constructor() { this.naturalWidth = width; this.naturalHeight = width; }
  set src(_url) { this.onload(); }
}
const window = {
  proj4: (_source, _target, coordinate) => coordinate,
  MaynardUtils: { BNG_PROJ4: "test" }
};
const document = {
  createElement: () => ({
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) })
  })
};
const terrainSource = fs.readFileSync("js/eta-terrain.js", "utf8");
vm.runInNewContext(terrainSource, { window, document, Image: FakeImage, setTimeout, clearTimeout });

(async () => {
  const terrain = window.MaynardEtaTerrain;
  assert.equal(terrain.isReady(), false);
  await terrain.load();
  assert.equal(terrain.isReady(), true);
  assert.equal(terrain.sample(225000 + 11 * 30, 105200 - 21 * 30), 115, "bilinear interpolation uses the surrounding cells");
  assert.equal(terrain.sample(225000, 105200), null, "outside the sample centres is unavailable");
  assert.equal(terrain.sample(225000 + 12 * 30, 105200 - 21 * 30), null, "missing cells are not treated as zero");
  let timeout;
  let requests = 0;
  class SlowImage { set src(_url) { requests++; } removeAttribute() {} }
  const slowWindow = {};
  vm.runInNewContext(terrainSource, {
    window: slowWindow, document, Image: SlowImage,
    setTimeout: (callback) => { timeout = callback; return 1; }, clearTimeout() {}
  });
  const slowLoad = slowWindow.MaynardEtaTerrain.load();
  const secondLoad = slowWindow.MaynardEtaTerrain.load();
  assert.equal(requests, 1, "concurrent terrain requests share one load");
  timeout();
  await Promise.all([
    assert.rejects(slowLoad, /Timed out loading Dartmoor terrain data/),
    assert.rejects(secondLoad, /Timed out loading Dartmoor terrain data/)
  ]);
  const retry = slowWindow.MaynardEtaTerrain.load();
  assert.equal(requests, 2, "a failed terrain load can be retried");
  timeout();
  await assert.rejects(retry, /Timed out loading Dartmoor terrain data/);
  console.log("ETA terrain interpolation tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
