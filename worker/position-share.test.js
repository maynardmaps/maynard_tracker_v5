import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import worker from "./relay.js";

test("shared-position API persists optional GPS accuracy and rejects invalid values", async () => {
  const stored = new Map();
  const env = {
    RATE_LIMIT: {
      async get(key, type) {
        if (key === "cfg:ipc") return { imeis: [], devices: [] };
        const value = stored.get(key);
        return value && type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) { stored.set(key, value); },
      async list({ prefix }) { return { keys: [...stored.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }; }
    }
  };
  const base = { latitude: 50, longitude: -4, name: "TEST", timestamp: Date.now() };
  const post = (body) => worker.fetch(new Request("https://example.test/positions/share", {
    method: "POST",
    body: JSON.stringify(body)
  }), env, {});
  const read = async () => (await (await worker.fetch(new Request("https://example.test/positions"), env, {})).json()).positions;

  assert.equal((await post({ ...base, accuracy: 12.3 })).status, 200);
  assert.equal((await read())[0].accuracy, 12.3);
  assert.equal((await post({ ...base, accuracy: 0 })).status, 200);
  assert.equal((await read())[0].accuracy, 0);
  assert.equal((await post(base)).status, 200);
  assert.equal((await read())[0].accuracy, undefined);
  for (const accuracy of [-1, "12", null]) {
    const response = await post({ ...base, accuracy });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid accuracy");
  }
  for (const sessionId of ["", "../other", "x".repeat(129), 12, null]) {
    const response = await post({ ...base, sessionId });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid session ID");
  }
});

test("browser reports reuse a persistent identity and update one Worker-backed marker", async () => {
  const stored = new Map();
  const browserStorage = new Map();
  const env = {
    RATE_LIMIT: {
      async get(key, type) {
        if (key === "cfg:ipc") return { imeis: [], devices: [] };
        const value = stored.get(key);
        return value && type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) { stored.set(key, value); },
      async list({ prefix }) { return { keys: [...stored.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }; }
    }
  };
  let releaseFirstUpload;
  const firstUploadGate = new Promise((resolve) => { releaseFirstUpload = resolve; });
  const posts = [];
  const fetchWorker = async (url, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      if (posts.length === 1) await firstUploadGate;
    }
    return worker.fetch(new Request(url, options), env, {});
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const source = readFileSync(new URL("../js/position-share.js", import.meta.url), "utf8");

  function createBrowser() {
    const callbacks = new Map();
    const markers = new Set();
    const gps = [];
    let nextId = 0;
    const group = {
      addTo(map) { map.layers.add(this); return this; },
      removeLayer(marker) { markers.delete(marker); }
    };
    const map = { layers: new Set(), hasLayer(layer) { return this.layers.has(layer); } };
    const context = {
      window: { MAYNARD_CONFIG: { garminRelayUrl: "https://example.test" }, crypto: webcrypto },
      localStorage: {
        getItem(key) { return browserStorage.get(key) || null; },
        setItem(key, value) { browserStorage.set(key, value); }
      },
      document: {
        hidden: false,
        addEventListener() {},
        createElement() { return { set textContent(value) { this.innerHTML = value; }, innerHTML: "" }; }
      },
      navigator: { geolocation: { getCurrentPosition(success) { gps.push(success); } } },
      MaynardPollingCoordinator: {
        subscribe(callback) { const id = nextId++; callbacks.set(id, callback); callback(); return id; },
        unsubscribe(id) { callbacks.delete(id); },
        updateInterval() {}
      },
      MaynardUtils: { createGpsBackoffTracker: () => ({ getNextRetryDelayMs: () => 300000, recordSuccess() {} }) },
      MaynardConnectionMonitor: { recordAttempt() {} },
      MaynardNearbyPicker: { register() {} },
      MaynardKmlMarkers: { gridRef() { return null; } },
      L: {
        featureGroup: () => group,
        divIcon: (options) => options,
        marker(coords) {
          return {
            coords,
            bindPopup(content) { this.popup = content; return this; },
            setPopupContent(content) { this.popup = content; return this; },
            addTo() { markers.add(this); return this; },
            setLatLng(next) { this.coords = next; }
          };
        }
      },
      fetch: fetchWorker,
      setTimeout: () => 1,
      clearTimeout() {},
      console
    };
    vm.runInNewContext(source, context);
    const share = context.window.MaynardPositionShare;
    share.init(map, { positionShare: { persistenceMinutes: 20 } });
    return { share, callbacks, markers, gps };
  }

  const browser = createBrowser();
  await settle();
  assert.equal(browser.share.enable("TEST"), true);
  assert.equal(browser.gps.length, 1);
  browser.gps[0]({ coords: { latitude: 50, longitude: -4, accuracy: 10 } });
  browser.callbacks.get(1)();
  assert.equal(browser.gps.length, 1, "a second GPS request waits for the first upload");
  assert.equal(posts.length, 1);
  releaseFirstUpload();
  await settle();
  assert.equal(browser.gps.length, 2);
  browser.callbacks.get(0)();
  await settle();
  const marker = [...browser.markers][0];
  assert.ok(marker);
  browser.gps[1]({ coords: { latitude: 51, longitude: -3, accuracy: 5 } });
  await settle();
  assert.equal(posts[1].sessionId, posts[0].sessionId);
  browser.callbacks.get(0)();
  await settle();
  assert.equal(browser.markers.size, 1);
  assert.equal([...browser.markers][0], marker);
  assert.deepEqual(Array.from(marker.coords), [51, -3]);
  assert.match(marker.popup, /Accuracy: 5 m/);

  browser.share.disable();
  const reloaded = createBrowser();
  await settle();
  assert.equal(reloaded.share.enable("TEST"), true);
  reloaded.gps[0]({ coords: { latitude: 52, longitude: -2, accuracy: 4 } });
  await settle();
  assert.equal(posts[2].sessionId, posts[0].sessionId, "identity survives a browser reload");
  const response = await worker.fetch(new Request("https://example.test/positions"), env, {});
  const positions = (await response.json()).positions;
  assert.equal(positions.length, 1);
  assert.equal(positions[0].latitude, 52);

  reloaded.callbacks.get(1)();
  assert.equal(reloaded.gps.length, 2);
  reloaded.share.disable();
  assert.equal(reloaded.share.enable("NEW"), true);
  assert.equal(reloaded.gps.length, 2, "restart waits for the previous GPS callback");
  reloaded.gps[1]({ coords: { latitude: 10, longitude: 10, accuracy: 10 } });
  assert.equal(posts.length, 3, "a GPS result from before stopping is discarded");
  assert.equal(reloaded.gps.length, 3);
  reloaded.gps[2]({ coords: { latitude: 54, longitude: -1, accuracy: 3 } });
  await settle();
  reloaded.callbacks.get(0)();
  await settle();
  assert.equal(reloaded.markers.size, 1);
  assert.match([...reloaded.markers][0].popup, /<strong>NEW<\/strong>/);

  const sameName = { ...posts[3], sessionId: "different-browser", latitude: 53 };
  assert.equal((await worker.fetch(new Request("https://example.test/positions/share", {
    method: "POST", body: JSON.stringify(sameName)
  }), env, {})).status, 200);
  const twoPositions = await worker.fetch(new Request("https://example.test/positions"), env, {});
  assert.equal((await twoPositions.json()).positions.length, 2, "matching names do not merge separate identities");
});
