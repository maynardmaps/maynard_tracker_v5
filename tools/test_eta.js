#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const window = {
  MaynardEtaTerrain: {
    isReady: () => true,
    sample: () => 0
  },
  MaynardUtils: {
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[char]),
  }
};
class FakeXmlDocument {
  constructor(text) { this.text = text; }
  getElementsByTagNameNS(_namespace, localName) {
    if (localName !== "Data") return [];
    return [...this.text.matchAll(/<Data\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/Data>/g)]
      .map((match) => ({
        getAttribute: () => match[1],
        getElementsByTagNameNS: (_namespace, childName) => childName === "value"
          ? [{ textContent: /<value\b[^>]*>([\s\S]*?)<\/value>/.exec(match[2])?.[1] || "" }]
          : []
      }));
  }
}
class FakeDOMParser {
  parseFromString(text) { return new FakeXmlDocument(text); }
}
vm.runInNewContext(fs.readFileSync("js/eta.js", "utf8"), {
  window,
  MaynardUtils: window.MaynardUtils,
  DOMParser: FakeDOMParser,
  toGeoJSON: {
    kml: () => ({ features: [{
      geometry: { type: "LineString", coordinates: [[-3, 50], [-2.99, 50]] },
      properties: { name: "Imported route" }
    }] })
  },
  console
});

const route = {
  id: "Test/route.gpx#0",
  label: "Test / route.gpx — Route 1",
  coordinates: [[-3, 50], [-2.99, 50], [-2.98, 50]]
};
const config = {
  eta: { enabled: true, staleMinutes: 30, lunchTime: "12:00", lunchDurationMinutes: 30 },
  devices: [{
    name: "Team A", etaRouteId: route.id, etaDirection: "forward", etaFallbackSpeedKmh: 5
  }]
};
const eta = window.MaynardEta;
eta.init([route], null, config);

const now = Date.now();
let info = eta.getInfo("Team A", 50, -2.9995, now - 600000);
assert.equal(info.status, "available");
assert.equal(info.speedSource, "fallback");
assert.equal(info.speedKmh, 5);
assert.ok(info.remainingKm > 0);

info = eta.getInfo("Team A", 50, -2.999, now - 1000);
assert.equal(info.status, "available");
assert.equal(info.speedSource, "measured");
assert.ok(info.speedKmh > 0 && info.speedKmh <= 160);
assert.equal(info.legIndex, 0);
assert.match(eta.popupHtml(info), /Distance remaining:/);
const etaHeadline = eta.headlineHtml(info);
assert.match(etaHeadline, /ETA<\/strong> \d{2}:\d{2} · .+/);
assert.doesNotMatch(etaHeadline, /\d{4}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);

const localTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
}).format(new Date(now));
const [currentHour, currentMinute] = localTime.split(":").map(Number);
const lunchAtOffset = (minutes) => {
  const total = ((currentHour * 60 + currentMinute + minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
config.eta.lunchTime = lunchAtOffset(120);
eta.init([route], null, config);
info = eta.getInfo("Team A", 50, -2.999, now);
assert.equal(info.speedSource, "fallback");
assert.equal(info.lunchIncluded, false);
config.eta.lunchTime = lunchAtOffset(1);
eta.init([route], null, config);
info = eta.getInfo("Team A", 50, -2.999, now);
assert.equal(info.lunchIncluded, true);
config.eta.lunchTime = lunchAtOffset(-1);
eta.init([route], null, config);
info = eta.getInfo("Team A", 50, -2.999, now);
assert.equal(info.lunchIncluded, false);

const isolatedDeviation = eta.getInfo("Team A", 50.02, -2.999, now + 1000);
assert.equal(isolatedDeviation.status, "available");
assert.equal(isolatedDeviation.lowConfidence, true);
const repeatedDeviation = eta.getInfo("Team A", 50.02, -2.999, now + 2000);
assert.equal(repeatedDeviation.status, "unavailable");
assert.equal(repeatedDeviation.reason, "off-route");

const stale = eta.getInfo("Team A", 50, -2.999, now - 60 * 60000);
assert.equal(stale.reason, "stale");
assert.equal(eta.getInfo("Unknown", 50, -2.999, now).status, "unassigned");

const reverseConfig = {
  ...config,
  devices: [{ ...config.devices[0], etaDirection: "reverse" }]
};
eta.init([route], null, reverseConfig);
info = eta.getInfo("Team A", 50, -2.9805, now);
assert.equal(info.status, "available");
assert.equal(info.direction, "reverse");
assert.equal(info.legIndex, 0);

const parallelRoute = {
  ...route,
  id: "Test/parallel.gpx#0",
  coordinates: [[-3, 50], [-2.97, 50], [-2.97, 50.0018], [-3, 50.0018]]
};
eta.init([parallelRoute], null, {
  ...config,
  devices: [{ ...config.devices[0], etaRouteId: parallelRoute.id }]
});
info = eta.getInfo("Team A", 50.0009, -2.985, now, 100);
assert.equal(info.status, "unavailable");
assert.equal(info.reason, "ambiguous");

const degenerateRoute = {
  ...route,
  id: "Test/degenerate.gpx#0",
  coordinates: [[-3, 50], [-3, 50]]
};
eta.init([degenerateRoute], null, {
  ...config,
  devices: [{ ...config.devices[0], etaRouteId: degenerateRoute.id }]
});
assert.equal(eta.getInfo("Team A", 50, -3, now).reason, "route");

eta.init([route], null, config);
assert.equal(eta.getInfo("Team A", 50, -2.999, now - 60 * 60000).reason, "stale");
info = eta.getInfo("Team A", 50, -2.999, now);
assert.equal(info.status, "available");
assert.equal(info.speedSource, "fallback");

eta.init([route], null, config);
info = eta.getInfo("Team A", 50, -2.9995, now - 60 * 60000, undefined, now);
assert.equal(info.status, "available");
assert.ok(info.ageMinutes < 1);
info = eta.getInfo("Team A", 50, -2.999, now - 50 * 60000, undefined, now + 1000);
assert.equal(info.status, "available");
assert.equal(info.speedSource, "measured");

eta.init([route], null, { ...config, eta: { ...config.eta, enabled: false } });
assert.equal(eta.getInfo("Team A", 50, -2.999, now).status, "disabled");

const terrainConfig = { ...config, eta: { ...config.eta, lunchDurationMinutes: 0 } };
window.MaynardEtaTerrain.sample = (lng) => lng <= -2.99
  ? (lng + 3) * 10000
  : 100 - (lng + 2.99) * 5000;
eta.init([route], null, terrainConfig);
info = eta.getInfo("Team A", 50, -3, now - 20 * 60000);
assert.ok(Math.abs(info.remainingAscentM - 100) < 0.01);
info = eta.getInfo("Team A", 50, -2.99, now);
const expectedSpeed = info.route.cumulative[1] / 1000 / (10 / 60);
assert.ok(Math.abs(info.speedKmh - expectedSpeed) < 0.001, "measured speed subtracts one minute per 10 m of climb");
assert.ok(info.remainingAscentM < 0.01, "descent does not add climb time");

eta.init([route], null, terrainConfig);
info = eta.getInfo("Team A", 50, -2.995, now);
assert.ok(Math.abs(info.remainingAscentM - 50) < 0.01, "remaining ascent starts at the matched position");
const expectedMinutes = info.remainingKm / 5 * 60 + 5;
assert.equal(info.duration, `${Math.round(expectedMinutes)}m`, "remaining ETA includes one minute per 10 m ascent");

eta.init([route], null, {
  ...terrainConfig,
  eta: { ...terrainConfig.eta, lunchTime: lunchAtOffset(15), lunchDurationMinutes: 30 }
});
info = eta.getInfo("Team A", 50, -2.995, now);
assert.equal(info.lunchIncluded, true, "climb time is included when deciding whether lunch is crossed");

eta.init([route], null, reverseConfig);
info = eta.getInfo("Team A", 50, -2.985, now);
assert.ok(Math.abs(info.remainingAscentM - 25) < 0.01, "reverse route counts ascent in its travel direction");

eta.init([route], null, terrainConfig);
eta.getInfo("Team A", 50, -2.98, now - 20 * 60000);
info = eta.getInfo("Team A", 50, -2.99, now);
const expectedBackwardSpeed = (info.route.total - info.route.cumulative[1]) / 1000 / (15 / 60);
assert.ok(Math.abs(info.speedKmh - expectedBackwardSpeed) < 0.001, "backward movement counts reverse ascent");

eta.init([route], null, terrainConfig);
eta.getInfo("Team A", 50, -3, now - 5 * 60000);
info = eta.getInfo("Team A", 50, -2.99, now);
assert.equal(info.speedSource, "fallback", "unusable climb-adjusted intervals use fallback speed");
assert.equal(info.lowConfidence, true);
assert.match(info.confidenceReason, /climb-adjusted/);

eta.init([route], null, terrainConfig);
eta.getInfo("Team A", 50, -3, now - 10 * 60000);
info = eta.getInfo("Team A", 50, -2.99, now);
assert.equal(info.speedSource, "fallback", "zero adjusted travel time is rejected");

eta.init([route], null, terrainConfig);
eta.getInfo("Team A", 50, -3, now - 10 * 60000 - 1000);
info = eta.getInfo("Team A", 50, -2.99, now);
assert.equal(info.speedSource, "fallback", "implausible adjusted speed is rejected");
assert.equal(info.lowConfidence, true);

window.MaynardEtaTerrain.sample = (lng) => lng > -2.99 ? null : 0;
eta.init([route], null, terrainConfig);
info = eta.getInfo("Team A", 50, -3, now);
assert.equal(info.reason, "elevation", "incomplete route elevation makes the ETA unavailable");
assert.match(eta.popupHtml(info), /route elevation data unavailable/);
const sparseRoute = { ...route, coordinates: [[-3, 50], [-2.99, 50]] };
window.MaynardEtaTerrain.sample = (lng) => Math.max(0, 80 - Math.abs(lng + 2.995) * 16000);
eta.init([sparseRoute], null, terrainConfig);
info = eta.getInfo("Team A", 50, -3, now);
assert.ok(Math.abs(info.remainingAscentM - 80) < 0.01, "terrain between route vertices contributes to ascent");
window.MaynardEtaTerrain.isReady = () => false;
eta.init([route], null, terrainConfig);
assert.equal(eta.getInfo("Team A", 50, -3, now).reason, "elevation", "an unloaded terrain dataset makes the ETA unavailable");
window.MaynardEtaTerrain.isReady = () => true;
window.MaynardEtaTerrain.sample = () => 0;

window.MaynardUtils.fetchText = async () =>
  `<kml><Placemark><ExtendedData><Data name="defaultSpeedKmh"><value>3.25</value></Data></ExtendedData></Placemark></kml>`;
eta.discoverRoutes({ folders: { "2026-01-02": ["imported.kml"] } }).then((definitions) => {
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].defaultSpeedKmh, 3.25);
  console.log("ETA calculations and imported KML default-speed discovery passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
