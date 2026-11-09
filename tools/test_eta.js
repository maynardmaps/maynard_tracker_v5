#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const window = {
  MaynardUtils: {
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[char]),
  }
};
vm.runInNewContext(fs.readFileSync("js/eta.js", "utf8"), {
  window, MaynardUtils: window.MaynardUtils, console
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

console.log("ETA calculations: fallback/measured speed, lunch handling, route matching, deviations, reverse travel, ambiguity, stale recovery, simulated observation timestamps and feature toggle passed.");
