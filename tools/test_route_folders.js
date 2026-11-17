"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let now = Date.parse("2026-03-28T23:59:59.500Z");
class FakeDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const timers = new Map();
const events = {};
let nextTimer = 0;
const context = {
  Date: FakeDate,
  window: { addEventListener(name, callback) { events[name] = callback; } },
  document: { hidden: false, addEventListener(name, callback) { events[name] = callback; } },
  setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }
};
vm.runInNewContext(fs.readFileSync("js/utils.js", "utf8"), context);
const utils = context.window.MaynardUtils;
const folders = ["TT10", "TT2", "TT1", "Other"];
const dates = { TT10: "2026-03-29", TT2: "2026-03-29", TT1: "2026-04-01", missing: "2026-03-28" };

assert.equal(utils.autoRouteFolder(folders, dates, "2026-03-29"), "TT2");
assert.equal(utils.autoRouteFolder(folders, dates, "2026-03-30"), "TT1");
assert.equal(utils.autoRouteFolder(folders, dates, "2026-04-02"), "TT1");
assert.equal(utils.autoRouteFolder(folders, { TT10: "2026-03-01", TT2: "2026-03-01" }, "2026-03-30"), "TT2");
assert.equal(utils.autoRouteFolder(folders, { missing: "2026-03-29", TT1: "2026-02-30" }, "2026-03-29"), null);
assert.equal(utils.isRouteDate("2024-02-29"), true);
assert.equal(utils.isRouteDate("2026-02-29"), false);
assert.equal(utils.londonDate(Date.parse("2026-06-01T22:59:59Z")), "2026-06-01");
assert.equal(utils.londonDate(Date.parse("2026-06-01T23:00:00Z")), "2026-06-02");
assert.equal(utils.londonDate(Date.parse("2026-12-01T23:00:00Z")), "2026-12-01");

const seen = [];
utils.watchLondonDate((day) => seen.push(day));
assert.deepEqual(seen, ["2026-03-28"]);
assert.equal([...timers.values()][0].delay, 500);
now += 500;
const scheduled = [...timers.values()][0].callback;
scheduled();
assert.deepEqual(seen, ["2026-03-28", "2026-03-29"]);
assert.equal([...timers.values()][0].delay, 23 * 60 * 60 * 1000, "DST transition makes this UK day 23 hours long");
now = Date.parse("2026-03-30T12:00:00Z");
events.visibilitychange();
assert.deepEqual(seen, ["2026-03-28", "2026-03-29", "2026-03-30"]);
events.focus();
assert.equal(seen.length, 3, "focus on the same day does not recalculate");

(async () => {
  const shared = { defaultRouteFolder: "TT1", routeFolderDates: { TT1: "2026-03-29" } };
  const storeContext = {
    URL,
    localStorage: {
      getItem(key) {
        return key === "maynard_settings_override_v2" ? JSON.stringify({ routeFolderDates: {} }) : null;
      },
      removeItem() {}
    },
    window: {
      MAYNARD_CONFIG: { defaultSettingsUrl: "settings.json" },
      location: { href: "https://example.test/config.html" },
      MaynardUtils: { fetchJson: async () => shared }
    },
    console
  };
  vm.runInNewContext(fs.readFileSync("js/settings-store.js", "utf8"), storeContext);
  const loaded = await storeContext.window.MaynardSettings.load();
  assert.deepEqual(Object.keys(loaded.routeFolderDates), [], "local date removals replace shared dates instead of merging them back");
  console.log("Route folder date selection tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
