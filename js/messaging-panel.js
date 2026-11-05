// messaging-panel.js - team messaging and tracking control panel, shared by the
// config page (Messaging section) and the test tool. Reads message history and
// tracking state from the Worker, and sends commands through /ipc/command.
(function (global) {
  "use strict";

  const POLL_MS = 15000;
  const TYPE_LABEL = { text: "Text", ok: "Puck", assist: "Puck", urgent: "Puck - urgent", sos: "SOS", "sos-cancelled": "SOS cancelled" };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function typeClass(t) {
    if (t === "sos") return "msg-sos";
    if (t === "urgent" || t === "assist" || t === "sos-cancelled") return "msg-urgent";
    if (t === "ok") return "msg-puck";
    return "msg-text";
  }

  function fmtTime(ms) {
    return ms ? new Date(ms).toLocaleString() : "";
  }

  function mount(root, opts) {
    const devices = opts.devices || [];
    const testTools = !!opts.testTools;
    const relay = window.MAYNARD_CONFIG.garminRelayUrl.replace(/\/$/, "");
    let timer = null;

    root.innerHTML = `
      <p class="status-msg">Last three messages received from each team, newest first. Updates automatically.</p>
      <div class="msg-teams"></div>
      <h3>Unregistered trackers</h3>
      <div class="msg-unregistered"><p class="msg-none">No unregistered trackers received.</p></div>
      <h3>Send a message</h3>
      <div class="msg-send">
        <label>Team <select class="msg-team"></select></label>
        <label>Message type <select class="msg-type"><option value="text">Text message</option></select></label>
        <textarea class="msg-text-in" maxlength="160" rows="2" placeholder="Message text (max 160 characters)"></textarea>
        <button type="button" class="msg-send-btn">Send message</button>
      </div>
      <h3>Tracking</h3>
      <div class="msg-track">
        <label>Team <select class="trk-team"></select></label>
        <label>Interval (minutes) <input type="number" class="trk-interval" min="1" max="1440" value="10" /></label>
        <button type="button" class="trk-start">Force start tracking</button>
        <button type="button" class="trk-stop secondary">Force stop tracking</button>
        <button type="button" class="trk-status secondary">Query status</button>
      </div>
      ${testTools ? `<label class="switch-row"><input type="checkbox" class="msg-fail" /> Simulate a Garmin failure for the next command</label>` : ""}
      <p class="status-msg msg-feedback" aria-live="polite"></p>
      ${testTools ? `<h3>Command log</h3><pre class="msg-cmdlog"></pre><button type="button" class="secondary msg-cmdlog-clear">Clear command log</button>` : ""}`;

    const q = (s) => root.querySelector(s);
    const options = devices.map((d) => `<option value="${esc(d.imei)}">${esc(d.name)} (${esc(d.imei)})</option>`).join("");
    q(".msg-team").innerHTML = options;
    q(".trk-team").innerHTML = options;

    function feedback(msg, kind) {
      const el = q(".msg-feedback");
      el.textContent = msg;
      el.className = "status-msg msg-feedback" + (kind ? " " + kind : "");
    }

    async function command(op) {
      if (testTools && q(".msg-fail").checked) { op.simulateFailure = true; q(".msg-fail").checked = false; }
      return MaynardGithubSave.ipcCommand(op, opts.passphrase());
    }

    function trackText(t) {
      if (!t) return "Tracking status unknown";
      const when = fmtTime(t.time);
      return (t.active ? "Tracking ACTIVE" : "Tracking STOPPED") + (t.active && t.interval ? ` (every ${t.interval} min)` : "") +
        (when ? ` - as of ${when}` : "") + (t.source ? ` [${t.source}]` : "");
    }

    async function refresh() {
      try {
        const res = await fetch(relay + "/ipc/locations", { cache: "no-store" });
        const locs = (await res.json()).locations || [];
        const byImei = new Map(locs.map((l) => [String(l.imei), l]));
        const registeredImeis = new Set(devices.map((d) => String(d.imei)));
        q(".msg-teams").innerHTML = devices.map((d) => {
          const l = byImei.get(String(d.imei)) || {};
          const hist = l.history || [];
          const rows = hist.length
            ? hist.map((h) => `<li class="${typeClass(h.type)}"><span class="msg-badge">${esc(TYPE_LABEL[h.type] || h.type)}</span> ${esc(h.text)} <time>${esc(fmtTime(h.time))}</time></li>`).join("")
            : '<li class="msg-none">No messages</li>';
          return `<div class="msg-team-card" data-imei="${esc(d.imei)}">
            <div class="msg-team-head"><strong>${esc(d.name)}</strong>
              <span class="msg-track-state">${esc(trackText(l.tracking))}</span>
              <button type="button" class="secondary msg-clear">Clear history</button></div>
            <ul class="msg-list">${rows}</ul></div>`;
        }).join("") || '<p class="status-msg">No devices configured.</p>';
        const unknown = locs.filter((l) => !registeredImeis.has(String(l.imei)));
        q(".msg-unregistered").innerHTML = unknown.length
            ? unknown.map((l) => {
              const point = l.coordinate ? `${l.coordinate.latitude}, ${l.coordinate.longitude}` : "No position";
              const hist = (l.history || []).map((h) => `${esc(TYPE_LABEL[h.type] || h.type)}: ${esc(h.text || "(no text)")} - ${esc(fmtTime(h.time))}`).join("<br>");
              return `<div class="msg-team-card"><div class="msg-team-head"><strong>Unregistered IMEI ${esc(l.imei)}</strong></div>
                <p class="status-msg">Last position: ${esc(point)}${l.timestamp ? ` - ${esc(fmtTime(Date.parse(l.timestamp)))}` : ""}</p>
                ${hist ? `<p class="status-msg">${hist}</p>` : ""}</div>`;
            }).join("")
            : '<p class="msg-none">No unregistered trackers received.</p>';
      } catch (e) {
        q(".msg-teams").innerHTML = '<p class="status-msg error">Could not load messages from the server.</p>';
        q(".msg-unregistered").innerHTML = '<p class="status-msg error">Could not load unregistered trackers.</p>';
      }
      if (testTools) {
        try {
          const r = await MaynardGithubSave.ipcCommand({ action: "cmdLog" }, opts.passphrase());
          q(".msg-cmdlog").textContent = (r.log || []).map((e) =>
            `${e.time}  ${e.action}  ${e.imei}  [${e.mode}]  ${e.ok ? "OK" : "FAILED: " + e.error}${e.text ? '  "' + e.text + '"' : ""}`).join("\n") || "(empty)";
        } catch (e) { /* best effort */ }
      }
    }

    root.addEventListener("click", async (ev) => {
      const t = ev.target;
      if (t.classList.contains("msg-clear")) {
        const imei = t.closest(".msg-team-card").dataset.imei;
        try { await command({ action: "clearHistory", imei }); feedback("History cleared.", "ok"); } catch (e) { feedback("Could not clear: " + e.message, "error"); }
        refresh();
      } else if (t.classList.contains("msg-send-btn")) {
        const text = q(".msg-text-in").value.trim();
        if (!text) { feedback("Enter a message first.", "error"); return; }
        const imei = q(".msg-team").value;
        t.disabled = true;
        feedback("Sending...");
        try {
          await command({ action: "sendMessage", imei, text });
          feedback("Message sent.", "ok");
          q(".msg-text-in").value = "";
        } catch (e) { feedback("Send failed: " + e.message, "error"); }
        t.disabled = false;
        refresh();
      } else if (t.classList.contains("trk-start") || t.classList.contains("trk-stop") || t.classList.contains("trk-status")) {
        const imei = q(".trk-team").value;
        const action = t.classList.contains("trk-start") ? "trackingStart" : t.classList.contains("trk-stop") ? "trackingStop" : "trackingStatus";
        const op = { action, imei };
        if (action === "trackingStart") op.interval = Number(q(".trk-interval").value);
        t.disabled = true;
        feedback("Sending...");
        try {
          const r = await command(op);
          feedback(action === "trackingStatus" ? trackText(r.tracking) : "Done: " + (action === "trackingStart" ? "tracking started." : "tracking stopped."), "ok");
        } catch (e) { feedback("Failed: " + e.message, "error"); }
        t.disabled = false;
        refresh();
      } else if (t.classList.contains("msg-cmdlog-clear")) {
        try { await MaynardGithubSave.ipcCommand({ action: "clearCmdLog" }, opts.passphrase()); } catch (e) { /* ignore */ }
        refresh();
      }
    });

    refresh();
    timer = setInterval(() => { if (document.body.contains(root) && !document.hidden) refresh(); }, POLL_MS);
    return { refresh, destroy: () => clearInterval(timer) };
  }

  global.MaynardMessaging = { mount };
})(window);
