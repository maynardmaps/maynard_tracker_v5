// github-save.js - asks the Cloudflare Worker to commit settings.json.
//
// The GitHub token never reaches the browser: it is a Worker secret. The
// Worker checks the config passphrase and can only write settings.json in
// the fixed repo. See worker/relay.js.
(function (global) {
  "use strict";

  function relayBase() {
    return (global.MAYNARD_CONFIG.garminRelayUrl || "").replace(/\/$/, "");
  }

  async function post(path, passphrase, body) {
    const base = relayBase();
    if (!base) throw new Error("No relay URL configured");
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "X-Config-Passphrase": passphrase, "Content-Type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body)
    });
    if (res.ok) return res.json();
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* keep default */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const verifyPassphrase = (passphrase) => post("/settings/verify", passphrase);
  const commitSettingsJson = (settingsObj, passphrase) => post("/settings", passphrase, settingsObj);

  global.MaynardGithubSave = { commitSettingsJson, verifyPassphrase };
})(window);
