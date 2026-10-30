// kml-markers.js - "KML Markers": polls the Garmin MapShare feed and renders
// points as markers with popups, refreshed periodically without a page reload.
(function (global) {
  "use strict";

  let layerGroup = null;
  let visible = true;
  let markerPalette = MaynardUtils.sanitizePalette();
  let pollTimer = null;
  let lastRawKml = null;

  function markerKey(feature) {
    const p = (feature && feature.properties) || {};
    return String(p["Map Display Name"] || p.name || "");
  }

  const isUnregistered = (f) => !!(f.properties && f.properties.Unregistered === "true");

  function buildLayer(geojson) {
    // Each point marker gets the next palette slot in alphanumerical order of
    // its display name; slots repeat after the palette is exhausted.
    const keys = [...new Set(
      geojson.features
        .filter((f) => f.geometry && f.geometry.type === "Point" && !isUnregistered(f))
        .map(markerKey)
    )];
    const colours = MaynardUtils.assignColours(keys, markerPalette);
    const geo = L.geoJson(geojson, {
      pointToLayer(feature, latlng) {
        const c = colours.get(markerKey(feature));
        const em = String((feature.properties || {})["In Emergency"]).toLowerCase() === "true";
        const s = em ? 54 : 18;
        return L.marker(latlng, { icon: L.divIcon({
          className: em ? "team-diamond team-emergency" : "team-diamond",
          html: `<span style="background:${c}"></span>`,
          iconSize: [s, s], iconAnchor: [s / 2, s / 2]
        }) });
      },
      onEachFeature(feature, layer) {
        layer.bindPopup(buildPopupHtml(feature.properties || {}, feature.geometry && feature.geometry.coordinates), { maxWidth: 320 });
      }
    });
    // Envelope beside each team that has sent a message, in the team's colour;
    // separate from the position marker and opens the message.
    const group = L.featureGroup([geo]);
    geojson.features.forEach((f) => {
      const p = f.properties || {};
      const type = p["Message Type"] || (String(p.Text || "").trim() ? "text" : "");
      if (!f.geometry || f.geometry.type !== "Point" || isUnregistered(f) || !type) return;
      const em = String(p["In Emergency"]).toLowerCase() === "true";
      const [lng, lat] = f.geometry.coordinates;
      const name = markerKey(f);
      const sos = type === "sos";
      const body = type === "sos" ? "SOS" + (p.Text ? " - " + String(p.Text).trim() : "")
        : type === "sos-cancelled" ? "SOS cancelled" + (p.Text ? " - " + String(p.Text).trim() : "")
        : String(p.Text || "").trim();
      const html = `<div class="kml-popup"><strong>${escapeHtml(name)} - last message</strong>` +
        (sos ? '<div class="kml-popup-emergency">SOS</div>' : "") +
        `<div class="kml-popup-desc">${escapeHtml(body)}</div>` +
        (p["Message Time"] ? `<div>${escapeHtml(p["Message Time"])}</div>` : "") + "</div>";
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: "team-message" + (sos ? " team-message-sos" : "") + (type === "urgent" ? " team-message-urgent" : ""),
          html: `<span style="background:${sos ? "#e00" : colours.get(name)}" title="Last message from ${escapeHtml(name)}">${sos ? "SOS" : type === "urgent" ? "&#9993;!" : "&#9993;"}</span>`,
          iconSize: sos ? [34, 20] : [22, 16], iconAnchor: [em ? -24 : -6, 22]
        }),
        alt: "Last message from " + name,
        zIndexOffset: sos ? 1000 : 0
      }).bindPopup(html, { maxWidth: 320 }).addTo(group);
    });
    return group;
  }

  // Fields shown first, in this order; any other non-empty KML field follows.
  const POPUP_FIELDS = [
    ["Time", "Time"],
    ["Time UTC", "Time (UTC)"],
    ["Text", "Message"],
    ["Message Time", "Message time"],
    ["Note", "Note"],
    ["Event", "Event"],
    ["Latitude", "Latitude"],
    ["Longitude", "Longitude"],
    ["Elevation", "Elevation"],
    ["Velocity", "Speed"],
    ["Course", "Course"],
    ["Valid GPS Fix", "GPS fix"],
    ["In Emergency", "Emergency"],
    ["Name", "Device"],
    ["Device Type", "Device type"]
  ];
  // Internal/duplicate fields not worth showing.
  const POPUP_HIDDEN = new Set(["Map Display Name", "Unregistered", "Message Type", "SpatialRefSystem", "Incident Id", "Device Identifier"]);

  // Opens the phone's native map app: Apple Maps on iOS, geo: intent on Android,
  // Google Maps web URL elsewhere.
  function mapAppUrl(lat, lng, label) {
    const ua = navigator.userAgent || "";
    const q = encodeURIComponent(label);
    if (/iPhone|iPad|iPod/.test(ua)) return `https://maps.apple.com/?ll=${lat},${lng}&q=${q}`;
    if (/Android/.test(ua)) return `geo:${lat},${lng}?q=${lat},${lng}(${q})`;
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }

  // OS grid reference (2 letters + 6 figures, 100 m) or null outside Great Britain.
  function gridRef(lat, lng) {
    if (!global.proj4 || !isFinite(lat) || !isFinite(lng)) return null;
    const [e, n] = global.proj4("EPSG:4326",
      MaynardUtils.BNG_PROJ4,
      [lng, lat]);
    if (e < 0 || e >= 700000 || n < 0 || n >= 1300000) return null;
    const e100 = Math.floor(e / 100000), n100 = Math.floor(n / 100000);
    let l1 = 19 - n100 - (19 - n100) % 5 + Math.floor((e100 + 10) / 5);
    let l2 = (19 - n100) * 5 % 25 + e100 % 5;
    if (l1 > 7) l1++;
    if (l2 > 7) l2++;
    const A = (i) => String.fromCharCode(65 + i);
    const pad = (v) => String(Math.floor((v % 100000) / 100)).padStart(3, "0");
    return `${A(l1)}${A(l2)} ${pad(e)} ${pad(n)}`;
  }
  function buildPopupHtml(props, coords) {
    const has = (k) => props[k] != null && String(props[k]).trim() !== "";
    const title = has("Map Display Name") ? props["Map Display Name"] : props.name || "Marker";
    const rows = [];
    const shown = new Set();
    const add = (key, label) => {
      shown.add(key);
      if (has(key)) rows.push([label, String(props[key]).trim()]);
    };
    POPUP_FIELDS.forEach(([k, l]) => add(k, l));
    Object.keys(props).forEach((k) => {
      if (!shown.has(k) && !POPUP_HIDDEN.has(k) && !EXCLUDED_PROPS.has(k) && k[0] !== "_") add(k, k);
    });

    const emergency = String(props["In Emergency"]).toLowerCase() === "true";
    let html = `<div class="kml-popup"><strong>${escapeHtml(title)}</strong>`;
    if (emergency) html += '<div class="kml-popup-emergency">EMERGENCY</div>';
    if (has("description") && !has("Time")) {
      html += `<div class="kml-popup-desc">${escapeHtml(props.description)}</div>`;
    }
    if (rows.length) {
      html +=
        '<table class="kml-popup-table">' +
        rows
          .map(([l, v]) => `<tr><th>${escapeHtml(l)}</th><td>${escapeHtml(v)}</td></tr>`)
          .join("") +
        "</table>";
    }
    if (coords && isFinite(coords[0]) && isFinite(coords[1])) {
      const gr = gridRef(coords[1], coords[0]);
      if (gr) html += `<div class="kml-popup-grid">Grid ref: ${gr}</div>`;
      const href = mapAppUrl(coords[1], coords[0], title);
      html += `<div class="kml-popup-map"><a href="${escapeHtml(href)}" title="Open in maps app" aria-label="Open in maps app" target="_blank" rel="noopener">&#128506; Map</a></div>`;
    }
    return html + "</div>";
  }

  // Standard KML/GeoJSON properties that aren't Garmin ExtendedData fields.
  const EXCLUDED_PROPS = new Set([
    "name", "description", "visibility", "styleUrl", "styleHash", "styleMapHash",
    "stroke", "stroke-opacity", "stroke-width", "fill", "fill-opacity", "icon",
    "icon-scale", "icon-offset", "icon-offset-units", "marker-color", "marker-size",
    "timestamp", "begin", "end", "when", "Id", "IMEI"
  ]);

  const escapeHtml = MaynardUtils.escapeHtml;

  function kmlTextToGeojson(kmlText) {
    const xml = new DOMParser().parseFromString(kmlText, "text/xml");
    return toGeoJSON.kml(xml);
  }

  // Latest positions pushed by Garmin IPC Outbound, stored by the Worker.
  // Devices not in Device management are returned flagged as unregistered.
  async function fetchIpc(relayUrl, devices) {
    const names = new Map(devices.map((d) => [d.imei, d.name]));
    const url = relayUrl.replace(/\/$/, "") + "/ipc/locations";
    const raw = await MaynardUtils.fetchText(url, { timeoutMs: 15000, cache: "no-store" });
    const locs = (JSON.parse(raw).locations || []).filter((l) => l.coordinate && isFinite(l.coordinate.latitude) && isFinite(l.coordinate.longitude));
    const registered = [], unregistered = [];
    locs.forEach((l) => {
      const imei = String(l.imei);
      const known = names.has(imei);
      const when = l.timestamp ? new Date(l.timestamp.endsWith("Z") || /[+-]\d\d:\d\d$/.test(l.timestamp) ? l.timestamp : l.timestamp + "Z") : null;
      const props = {
        "Map Display Name": known ? names.get(imei) : "Unregistered " + imei,
        "Time": when && !isNaN(when) ? when.toLocaleString() : "",
        "Time UTC": when && !isNaN(when) ? when.toUTCString() : "",
        "Latitude": l.coordinate.latitude,
        "Longitude": l.coordinate.longitude,
        "Elevation": l.altitude != null ? l.altitude + " m" : "",
        "Velocity": l.speed != null ? l.speed + " km/h" : "",
        "Course": l.course != null ? l.course + " � True" : "",
        "In Emergency": l.inEmergency === true ? "True" : "False",
        "Text": l.text || "",
        "Message Time": l.textTime ? new Date(l.textTime).toLocaleString() : "",
        "Message Type": l.messageType || "",
        "Note": known ? "" : "Unregistered device (IMEI " + imei + ")",
        "Battery": l.lowBattery ? "Low" : "",
        "Unregistered": known ? "false" : "true",
        "_posTime": Date.parse(l.timestamp) || 0,
        "_msgTime": l.textTime || 0
      };
      (known ? registered : unregistered).push({
        type: "Feature", properties: props,
        geometry: { type: "Point", coordinates: [l.coordinate.longitude, l.coordinate.latitude] }
      });
    });
    return { registered, unregistered };
  }

  // KML time fields look like "10/30/2026 9:57:12 PM" (UTC in "Time UTC").
  function kmlTimeMs(props) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec(String(props["Time UTC"] || "").trim());
    if (m) {
      let h = Number(m[4]) % 12;
      if (/^P/i.test(m[7] || "")) h += 12;
      else if (!m[7]) h = Number(m[4]);
      return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]), Number(m[6]));
    }
    const t = Date.parse(props.timestamp || props.when || props.begin || "");
    return isNaN(t) ? 0 : t;
  }

  // Per team, show the newest position and the newest message across the push
  // feed and the MapShare KML, so whichever source is current wins and a silent
  // failure of one is covered by the other.
  function mergeTeams(ipcFeatures, kmlFeatures, devices) {
    const names = new Map(devices.map((d) => [d.imei, d.name]));
    const teams = new Map();
    const others = [];
    const slot = (key) => { if (!teams.has(key)) teams.set(key, {}); return teams.get(key); };
    ipcFeatures.forEach((f) => { slot(markerKey(f)).ipc = f; });
    kmlFeatures.forEach((f) => {
      if (!f.geometry || f.geometry.type !== "Point") { others.push(f); return; }
      const p = f.properties || {};
      const key = names.get(String(p.IMEI || p.Id || "").trim()) || markerKey(f);
      const t = slot(key);
      if (!t.kml || kmlTimeMs(p) > kmlTimeMs(t.kml.properties || {})) t.kml = f;
    });

    const out = [];
    let fromIpc = 0, fromKml = 0;
    teams.forEach((t, key) => {
      const i = t.ipc, k = t.kml;
      const ip = i ? i.properties : null, kp = k ? k.properties : null;
      const iPos = ip ? ip._posTime || 0 : -1, kPos = kp ? kmlTimeMs(kp) : -1;
      const posSrc = iPos >= kPos ? i : k;
      const hasText = (p) => p && String(p.Text || "").trim() !== "";
      const iMsg = hasText(ip) ? ip._msgTime || 0 : -1;
      const kMsg = hasText(kp) ? kPos : -1;
      const msgSrc = iMsg < 0 && kMsg < 0 ? null : (iMsg >= kMsg ? i : k);
      const props = Object.assign({}, posSrc.properties, { "Map Display Name": key });
      delete props._posTime; delete props._msgTime;
      const mp = msgSrc && msgSrc.properties;
      props.Text = mp ? mp.Text : "";
      props["Message Time"] = mp ? (msgSrc === i ? mp["Message Time"] : mp.Time || "") : "";
      props["Message Type"] = mp ? (msgSrc === i ? mp["Message Type"] : "text") : "";
      const iLatest = ip ? Math.max(iPos, iMsg) : -1, kLatest = kp ? kPos : -1;
      props["In Emergency"] = (iLatest >= kLatest ? ip : kp)["In Emergency"];
      props["Position source"] = posSrc === i ? "Garmin push" : "MapShare KML";
      if (posSrc === i) fromIpc++; else fromKml++;
      out.push({ type: "Feature", properties: props, geometry: posSrc.geometry });
    });
    return { features: out.concat(others), fromIpc, fromKml };
  }

  async function refresh(map, relayUrl, devices) {
    let ipc = { registered: [], unregistered: [] };
    let ipcError = null;
    let kmlError = null;
    let kmlFeatures = [];
    const [ipcRes, kmlRes] = await Promise.allSettled([
      fetchIpc(relayUrl, devices || []),
      MaynardUtils.fetchText(relayUrl, { timeoutMs: 15000, cache: "no-store" })
    ]);
    if (ipcRes.status === "fulfilled") ipc = ipcRes.value; else ipcError = ipcRes.reason.message;
    if (kmlRes.status === "fulfilled") {
      try {
        const gj = kmlTextToGeojson(kmlRes.value);
        if (!gj || !gj.features || !gj.features.length) throw new Error("no features returned");
        kmlFeatures = gj.features;
      } catch (e) { kmlError = e.message; }
    } else kmlError = kmlRes.reason.message;

    if (ipcError && kmlError) {
      console.warn("Team position refresh failed (will retry)", ipcError, kmlError);
      MaynardUtils.diag("Garmin", false, "all sources failed: push feed: " + ipcError + "; MapShare KML: " + kmlError);
      MaynardUtils.setStatus("garmin", layerGroup ? "Team positions could not be updated (showing last known)" : "Team positions unavailable");
      return;
    }
    MaynardUtils.setStatus("garmin", null);
    const merged = mergeTeams(ipc.registered, kmlFeatures, devices || []);
    const features = merged.features.concat(ipc.unregistered);
    MaynardUtils.diag("Garmin", !ipcError && !kmlError,
      `newest data per team: ${merged.fromIpc} from push feed, ${merged.fromKml} from MapShare KML` +
      (ipcError ? "; push feed failed: " + ipcError : "") + (kmlError ? "; MapShare KML failed: " + kmlError : "") +
      (ipc.unregistered.length ? "; " + ipc.unregistered.length + " unregistered device(s)" : ""));
    const sig = JSON.stringify(features);
    if (sig === lastRawKml) return; // unchanged
    lastRawKml = sig;
    if (layerGroup && map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
    layerGroup = buildLayer({ type: "FeatureCollection", features });
    if (visible) layerGroup.addTo(map);
  }
  function start(map, { relayUrl, pollIntervalMs, palette, startVisible, devices }) {
    markerPalette = MaynardUtils.sanitizePalette(palette);
    visible = startVisible !== false;
    refresh(map, relayUrl, devices);
    stop();
    pollTimer = setInterval(() => refresh(map, relayUrl, devices), pollIntervalMs);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function setVisible(v, map) {
    visible = v;
    if (!layerGroup) return;
    if (visible) layerGroup.addTo(map);
    else if (map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
  }

  function getBounds() {
    return layerGroup && layerGroup.getBounds().isValid() ? layerGroup.getBounds() : null;
  }

  function reattach(map) {
    if (layerGroup && visible) layerGroup.addTo(map);
  }

  global.MaynardKmlMarkers = { start, stop, setVisible, getBounds, reattach, mapAppUrl, gridRef };
})(window);
