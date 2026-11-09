// test-page.js - injects fake Garmin IPC Outbound events through the Worker (test mode only).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let passphrase = "";
  let walkTimer = null;

  function logLine(text) {
    const el = $("t-session-log");
    el.textContent = new Date().toLocaleTimeString() + "  " + text + "\n" + el.textContent;
  }

  async function call(op) {
    try {
      return await MaynardGithubSave.ipcTest(op, passphrase);
    } catch (e) {
      logLine("FAILED: " + e.message);
      throw e;
    }
  }

  function makeEvent(imei, lat, lon, code, text, low, eventTimeMs) {
    const ev = {
      imei, messageCode: code,
      timeStamp: (Number.isFinite(eventTimeMs) ? eventTimeMs : Date.now()) - Math.max(0, Number($("t-age").value) || 0) * 60000,
      point: { latitude: lat, longitude: lon, altitude: 100, gpsFix: 2, course: 0, speed: 0 },
      status: { autonomous: 0, lowBattery: low ? 1 : 0, intervalChange: 0, resetDetected: 0 }
    };
    if (code === 3 || code === 4) ev.freeText = text;
    return ev;
  }

  function currentImei() {
    const custom = $("t-imei-custom").value.trim();
    const imei = custom || $("t-imei").value;
    if (!/^\d{15}$/.test(imei)) { logLine("IMEI must be 15 digits"); return null; }
    return imei;
  }

  async function send(lat, lon) {
    const imei = currentImei();
    if (!imei) return false;
    const code = Number($("t-code").value);
    await call({ action: "inject", events: [makeEvent(imei, lat, lon, code, $("t-text").value, $("t-low").checked)] });
    logLine(`Sent code ${code} for ${imei} at ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    return true;
  }

  function stopWalk() {
    if (walkTimer) clearInterval(walkTimer);
    walkTimer = null;
    $("t-stop").disabled = true;
    $("t-walk").disabled = false;
  }

  function startWalk() {
    let lat = Number($("t-lat").value), lon = Number($("t-lon").value), n = 0;
    $("t-code").value = "0";
    $("t-walk").disabled = true;
    $("t-stop").disabled = false;
    walkTimer = setInterval(async () => {
      lat += 0.0004; lon += 0.0003;
      $("t-lat").value = lat.toFixed(5);
      $("t-lon").value = lon.toFixed(5);
      try { await send(lat, lon); } catch (e) { stopWalk(); return; }
      if (++n >= 20) stopWalk();
    }, 2000);
  }

  async function refreshLog() {
    try {
      const { log } = await call({ action: "log" });
      $("t-garmin-log").textContent = log.length
        ? log.map((l) => `${l.time}  HTTP ${l.status}${l.reason ? " (" + l.reason + ")" : ""}  type=${l.contentType || "-"}\n    headers: ${l.headers.join(", ")}\n    payload${l.payloadTruncated ? " (truncated)" : ""}: ${l.payload || "(empty)"}`).join("\n")
        : "No requests received from Garmin yet.";
    } catch (e) { /* already logged */ }
  }

  async function loadDevices() {
    try {
      const s = await MaynardSettings.load();
      $("t-imei").innerHTML = (s.devices || []).map((d) => `<option value="${d.imei}">${String(d.name).replace(/</g, "&lt;")} (${d.imei})</option>`).join("");
      if (s.mode !== "test") {
        logLine("Settings say mode is NORMAL - injection and the stale-icon override require Test mode to be saved.");
      } else {
        $("stale-data-test").hidden = false;
        const override = $("show-stale-map-data");
        override.checked = MaynardUtils.showStaleMapDataTestOverride();
        override.addEventListener("change", () => {
          try {
            if (override.checked) localStorage.setItem(MaynardUtils.STALE_MAP_DATA_TEST_OVERRIDE_KEY, "true");
            else localStorage.removeItem(MaynardUtils.STALE_MAP_DATA_TEST_OVERRIDE_KEY);
            logLine(`Stale Garmin and river-level icons ${override.checked ? "shown" : "hidden by age limit"} on open Test mode maps.`);
          } catch (e) {
            logLine("Could not save stale-icon override: " + e.message);
            override.checked = MaynardUtils.showStaleMapDataTestOverride();
          }
        });
      }
      MaynardMessaging.mount($("t-msg-root"), { devices: s.devices || [], passphrase: () => passphrase, testTools: true });
    } catch (e) { logLine("Could not load settings.json"); }
  }

  // ---- Route simulation ----
  const DEFAULT_STEP_SECONDS = 10;
  const TURN_DEGREES = 40;
  const TURN_MIN_GAP_M = 200;
  const R = 6371000;
  const rad = (d) => d * Math.PI / 180;

  function distM(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // pts: [[lat, lon], ...]. Returns cumulative distances, the points (tiny
  // segments dropped) and the cumulative distances of the first turns.
  function analyseRoute(raw) {
    const pts = [raw[0]];
    raw.forEach((p) => { if (distM(pts[pts.length - 1], p) >= 25) pts.push(p); });
    if (distM(pts[pts.length - 1], raw[raw.length - 1]) > 0) pts.push(raw[raw.length - 1]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
    const turns = [];
    for (let i = 1; i < pts.length - 1; i++) {
      let d = Math.abs(bearing(pts[i - 1], pts[i]) - bearing(pts[i], pts[i + 1]));
      if (d > 180) d = 360 - d;
      if (d >= TURN_DEGREES && (!turns.length || cum[i] - turns[turns.length - 1] >= TURN_MIN_GAP_M)) turns.push(cum[i]);
    }
    return { pts, cum, turns, total: cum[cum.length - 1] };
  }

  function pointAt(a, dist) {
    if (dist <= 0) return a.pts[0];
    if (dist >= a.total) return a.pts[a.pts.length - 1];
    let i = 1;
    while (a.cum[i] < dist) i++;
    const f = (dist - a.cum[i - 1]) / ((a.cum[i] - a.cum[i - 1]) || 1);
    const p = a.pts[i - 1], q = a.pts[i];
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  }

  // Turn messages land on the first report at or after each detected turn.
  function buildSteps(a, speedKmh, varySpeed, stepSeconds) {
    const script = [{ code: 3, text: "first turn" }, { code: 14 }, { code: 15 }, { code: 16 }];
    const steps = [];
    let next = 0, d = 0, report = 0;
    while (d < a.total) {
      const factor = varySpeed ? [0.7, 1.3, 1][report % 3] : 1;
      const stepMetres = speedKmh * factor / 3.6 * stepSeconds;
      const [lat, lon] = pointAt(a, d);
      const s = { lat, lon, code: 0 };
      if (next < script.length && next < a.turns.length && d + stepMetres > a.turns[next]) Object.assign(s, script[next++]);
      steps.push(s);
      d += stepMetres;
      report++;
    }
    const [lat, lon] = a.pts[a.pts.length - 1];
    steps.push({ lat, lon, code: 4, text: "SOS" });
    return { steps, turnsFound: Math.min(a.turns.length, script.length) };
  }

  async function loadManifest() {
    const base = (window.MAYNARD_CONFIG.garminRelayUrl || "").replace(/\/$/, "");
    try {
      const res = await fetch(base + "/routes", { cache: "no-store" });
      if (res.ok) { const m = await res.json(); if (m && m.folders) return m; }
    } catch (e) { /* fall back to static manifest */ }
    return (await fetch(window.MAYNARD_CONFIG.routesManifestUrl, { cache: "no-store" })).json();
  }

  async function loadRouteList() {
    try {
      const m = await loadManifest();
      const opts = [];
      Object.keys(m.folders).sort().forEach((f) => m.folders[f].forEach((file) => {
        opts.push(`<option value="${encodeURIComponent(f)}/${encodeURIComponent(file)}">${f} / ${file}</option>`.replace(/&(?!amp;)/g, "&amp;"));
      }));
      $("r-route").innerHTML = opts.join("") || '<option value="">(no routes)</option>';
    } catch (e) { logLine("Could not load route list: " + e.message); }
  }

  async function loadRoutePoints(path) {
    const text = await (await fetch("routes/" + path, { cache: "no-store" })).text();
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const gj = /\.gpx$/i.test(path) ? toGeoJSON.gpx(xml) : toGeoJSON.kml(xml);
    let best = [];
    gj.features.forEach((f) => {
      const g = f.geometry;
      if (!g) return;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      lines.forEach((l) => { if (l.length > best.length) best = l; });
    });
    return best.map((c) => [c[1], c[0]]);
  }

  function stopRoute(msg) {
    stopWalk();
    $("r-start").disabled = false;
    $("r-stop").disabled = true;
    if (msg) $("r-status").textContent = msg;
  }

  async function startRoute() {
    const imei = currentImei();
    const path = $("r-route").value;
    if (!imei || !path) { logLine("Choose a device and a route first"); return; }
    $("r-status").textContent = "Loading route...";
    let sim;
    try {
      const raw = await loadRoutePoints(path.split("/").map(decodeURIComponent).join("/"));
      if (raw.length < 2) throw new Error("no line found in the route file");
      const speed = Number($("r-speed-kmh").value);
      if (!Number.isFinite(speed) || speed <= 0 || speed > 160) throw new Error("speed must be between 0.1 and 160 km/h");
      const stepSeconds = Number($("r-interval-seconds").value) || DEFAULT_STEP_SECONDS;
      const a = analyseRoute(raw);
      sim = buildSteps(a, speed, $("r-vary-speed").checked, stepSeconds);
      logLine(`Route ${decodeURIComponent(path)}: ${(a.total / 1000).toFixed(2)} km, ${sim.steps.length} reports every ${stepSeconds / 60} min, ${a.turns.length} turn(s) detected`);
      if (sim.turnsFound < 4) logLine(`Only ${sim.turnsFound} of the 4 turn messages can be sent on this route`);
      sim.stepSeconds = stepSeconds;
    } catch (e) { $("r-status").textContent = "Could not load route: " + e.message; return; }

    const speedup = Number($("r-speedup").value || 1);
    const interval = sim.stepSeconds * 1000 / speedup;
    const simulationStart = Date.now() - (sim.steps.length - 1) * (sim.stepSeconds * 1000 - interval);
    let n = 0;
    $("r-start").disabled = true;
    $("r-stop").disabled = false;
    $("t-walk").disabled = true;
    $("t-stop").disabled = false;
    const tick = async () => {
      const s = sim.steps[n++];
      $("r-status").textContent = `Step ${n} of ${sim.steps.length}`;
      try {
        const eventTimeMs = simulationStart + (n - 1) * sim.stepSeconds * 1000;
        await call({ action: "inject", events: [makeEvent(imei, s.lat, s.lon, s.code, s.text, false, eventTimeMs)] });
        logLine(`Route step ${n}/${sim.steps.length}: code ${s.code}${s.text ? ' "' + s.text + '"' : ""} at ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`);
      } catch (e) { stopRoute("Stopped: " + e.message); return; }
      if (n >= sim.steps.length) stopRoute("Route simulation finished (SOS sent).");
    };
    tick();
    if (n < sim.steps.length) walkTimer = setInterval(tick, interval);
  }

  async function unlock() {
    const entered = $("test-password").value;
    $("password-status").textContent = "Checking...";
    try {
      await MaynardGithubSave.verifyPassphrase(entered);
      passphrase = entered;
      $("locked-overlay").style.display = "none";
      $("test-form").style.display = "";
      await loadDevices();
      loadRouteList();
      refreshLog();
    } catch (e) {
      $("password-status").textContent = e.status === 401 ? "Incorrect password." : "Could not verify (" + e.message + ").";
    }
  }

  $("unlock-btn").addEventListener("click", unlock);
  $("test-password").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  $("t-send").addEventListener("click", () => send(Number($("t-lat").value), Number($("t-lon").value)).catch(() => {}));
  $("t-walk").addEventListener("click", startWalk);
  $("t-stop").addEventListener("click", stopWalk);
  $("r-start").addEventListener("click", startRoute);
  $("r-stop").addEventListener("click", () => stopRoute("Stopped."));
  $("t-clear").addEventListener("click", () => call({ action: "clear" }).then(() => logLine("Cleared stored positions")).catch(() => {}));
  $("t-log-refresh").addEventListener("click", refreshLog);
  $("t-log-clear").addEventListener("click", () => call({ action: "clearLog" }).then(refreshLog).catch(() => {}));
})();
