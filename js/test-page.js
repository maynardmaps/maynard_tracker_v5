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

  function makeEvent(imei, lat, lon, code, text, low) {
    const ev = {
      imei, messageCode: code, timeStamp: Date.now() - Math.max(0, Number($("t-age").value) || 0) * 60000,
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
        ? log.map((l) => `${l.time}  HTTP ${l.status}${l.reason ? " (" + l.reason + ")" : ""}  type=${l.contentType || "-"}\n    headers: ${l.headers.join(", ")}`).join("\n")
        : "No requests received from Garmin yet.";
    } catch (e) { /* already logged */ }
  }

  async function loadDevices() {
    try {
      const s = await (await fetch("settings.json", { cache: "no-store" })).json();
      $("t-imei").innerHTML = (s.devices || []).map((d) => `<option value="${d.imei}">${String(d.name).replace(/</g, "&lt;")} (${d.imei})</option>`).join("");
      if (s.mode !== "test") logLine("settings.json says mode is NORMAL - injection will be refused until Test mode is saved.");
    } catch (e) { logLine("Could not load settings.json"); }
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
  $("t-clear").addEventListener("click", () => call({ action: "clear" }).then(() => logLine("Cleared stored positions")).catch(() => {}));
  $("t-log-refresh").addEventListener("click", refreshLog);
  $("t-log-clear").addEventListener("click", () => call({ action: "clearLog" }).then(refreshLog).catch(() => {}));
})();
