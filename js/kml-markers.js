// kml-markers.js - "KML Markers": polls the Garmin MapShare feed and renders
// points as markers with popups, refreshed periodically without a page reload.
(function (global) {
  "use strict";

  let layerGroup = null;
  let visible = true;
  let markerPalette = MaynardUtils.sanitizePalette();
  let pollTimer = null;
  let lastRawKml = null;
  let latestFeatures = [];
  let maxAgeMs = 12 * 60 * 60 * 1000;
  let testMode = false;
  let showStaleOverride = false;

  function featureIsVisible(feature) {
    if (testMode && showStaleOverride) return true;
    const props = feature.properties || {};
    const timestamp = props._isMessage
      ? Number(props.timeMs) || parseKmlTime(props.time)
      : kmlTimeMs(props);
    return timestamp <= 0 || Date.now() - timestamp <= maxAgeMs;
  }

  function markerKey(feature) {
    const p = (feature && feature.properties) || {};
    return String(p["Map Display Name"] || p.name || "");
  }

  const isUnregistered = (f) => !!(f.properties && f.properties.Unregistered === "true");
  const NAV_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2 4.5 21 12 17l7.5 4L12 2Zm0 5.2 4.2 10.1-4.2-2.2-4.2 2.2L12 7.2Z"/></svg>';

  function popupContent(html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container.firstElementChild || container;
  }

  function buildLayer(geojson) {
    // Each point marker gets the next palette slot in alphanumerical order of
    // its display name; slots repeat after the palette is exhausted.
    const keys = [...new Set(
      geojson.features
        .filter((f) => f.geometry && f.geometry.type === "Point" && !isUnregistered(f))
        .map(markerKey)
    )];
    const colours = MaynardUtils.assignColours(keys, markerPalette);
    const keyed = {};
    const geo = L.geoJson(geojson, {
      filter: (f) => !(f.properties && f.properties._isMessage) && featureIsVisible(f),
      pointToLayer(feature, latlng) {
        const c = colours.get(markerKey(feature));
        const em = String((feature.properties || {})["In Emergency"]).toLowerCase() === "true";
        const s = em ? 54 : 18;
        const popupY = em ? -19.5 : -s / 2;
        return L.marker(latlng, { icon: L.divIcon({
          className: em ? "team-diamond team-emergency" : "team-diamond",
          html: `<span style="background:${c}"></span>`,
          iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, popupY]
        }) });
      },
      onEachFeature(feature, layer) {
        const props = feature.properties || {};
        const coords = feature.geometry && feature.geometry.coordinates;
        const etaInfo = coords && MaynardEta
          ? MaynardEta.getInfo(markerKey(feature), coords[1], coords[0],
            Number(props._simulationTimeMs) || Number(props._positionTimeMs) || kmlTimeMs(props),
            Number(props["GPS Accuracy"]), Number(props._positionTimeMs) || kmlTimeMs(props))
          : { status: "disabled" };
        layer._etaInfo = etaInfo;
        layer._etaTeam = markerKey(feature);
        layer.bindPopup(popupContent(buildPopupHtml(props, coords, MaynardEta ? MaynardEta.popupHtml(etaInfo) : "")), { maxWidth: 520 });
        if (feature.geometry && feature.geometry.type === "Point") {
          MaynardNearbyPicker.register(layer, "Team position", markerKey(feature));
        }
        keyed["pos:" + markerKey(feature)] = layer;
      }
    });
    // Message marker per team, fixed where the last message was received and
    // independent of the moving position marker.
    const group = L.featureGroup([geo]);
    geojson.features.forEach((f) => {
      const p = f.properties || {};
      if (!p._isMessage || !f.geometry || !featureIsVisible(f)) return;
      const type = p.type;
      const name = markerKey(f);
      const sos = type === "sos";
      const cancelled = type === "sos-cancelled";
      const urgent = type === "urgent";
      const [lng, lat] = f.geometry.coordinates;
      const label = sos ? "SOS" : cancelled ? "SOS cancelled" : type === "ok" || type === "assist" || urgent ? "Puck message" : "Text message";
      const rows = [["Message", p.text || (sos ? "SOS" : "")], ["Type", label], ["Received", p.time], ["Latitude", formatCoordinate(lat)], ["Longitude", formatCoordinate(lng)],
        ["Elevation", p.elevation], ["Speed", p.speed], ["Course", p.course], ["Source", p.source]]
        .filter(([, v]) => v !== "" && v != null);
      const gr = gridRef(lat, lng);
      const location = gr ? `<div class="kml-popup-grid">Grid ref: ${escapeHtml(gr)}</div>` :
        `<div class="kml-popup-grid">Location: ${formatCoordinate(lat)}, ${formatCoordinate(lng)}</div>`;
      const messageTime = Number.isFinite(p.timeMs) ? p.timeMs : parseKmlTime(p.time);
      const messageAge = MaynardUtils.timeSince(messageTime);
      const html = `<div class="kml-popup"><strong>${escapeHtml(name)} - last message</strong>` +
        (messageAge ? `<div class="kml-popup-age">${escapeHtml(messageAge)}</div>` : "") +
        location +
        `<div class="kml-popup-emergency${sos ? "" : " kml-popup-emergency-clear"}">${sos ? "EMERGENCY: SOS" : "No emergency"}</div>` +
        `<div class="kml-popup-nav"><a href="${escapeHtml(mapAppUrl(lat, lng, name + " message"))}" title="Open location in maps" aria-label="Nav to ${escapeHtml(name)} in maps" target="_blank" rel="noopener">${NAV_ICON} Nav to</a></div>` +
        '<details class="kml-popup-details"><summary>More details</summary>' +
        '<table class="kml-popup-table">' + rows.map(([l, v]) => `<tr><th>${escapeHtml(l)}</th><td>${l === "Message" ? `<strong>${escapeHtml(String(v))}</strong>` : escapeHtml(String(v))}</td></tr>`).join("") + "</table>" +
        "</details></div>";
      const iconSize = sos ? [34, 20] : [22, 16];
      const iconAnchor = sos ? [17, 26] : [11, 22];
      const m = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "team-message" + (sos ? " team-message-sos" : "") + (urgent ? " team-message-urgent" : ""),
          html: `<span style="background:${sos ? "#e00" : colours.get(name)}" title="Last message from ${escapeHtml(name)}">${sos ? "SOS" : urgent ? "&#9993;!" : "&#9993;"}</span>`,
          iconSize, iconAnchor, popupAnchor: [0, -iconAnchor[1]]
        }),
        alt: "Last message from " + name,
        zIndexOffset: sos ? 1000 : 0
      }).bindPopup(popupContent(html), { maxWidth: 520 }).addTo(group);
      MaynardNearbyPicker.register(m, "Team message", name);
      keyed["msg:" + name] = m;
    });
    group._keyed = keyed;
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
  function buildPopupHtml(props, coords, etaHtml) {
    const has = (k) => props[k] != null && String(props[k]).trim() !== "";
    const title = has("Map Display Name") ? props["Map Display Name"] : props.name || "Marker";
    const positionAge = MaynardUtils.timeSince(kmlTimeMs(props));
    const lat = coords && Number.isFinite(Number(coords[1])) ? Number(coords[1]) :
      (has("Latitude") && Number.isFinite(Number(props.Latitude)) ? Number(props.Latitude) : null);
    const lng = coords && Number.isFinite(Number(coords[0])) ? Number(coords[0]) :
      (has("Longitude") && Number.isFinite(Number(props.Longitude)) ? Number(props.Longitude) : null);
    const hasCoordinates = lat !== null && lng !== null;
    const gr = hasCoordinates ? gridRef(lat, lng) : null;
    const rows = [];
    const shown = new Set();
    const add = (key, label) => {
      shown.add(key);
      if ((key === "Latitude" || key === "Longitude") && hasCoordinates) return;
      if (has(key)) rows.push([label, String(props[key]).trim()]);
    };
    POPUP_FIELDS.forEach(([k, l]) => add(k, l));
    Object.keys(props).forEach((k) => {
      if (!shown.has(k) && !POPUP_HIDDEN.has(k) && !EXCLUDED_PROPS.has(k) && k[0] !== "_") add(k, k);
    });
    if (hasCoordinates) {
      rows.push(["Latitude", formatCoordinate(lat)], ["Longitude", formatCoordinate(lng)]);
    }

    const emergency = String(props["In Emergency"]).toLowerCase() === "true";
    let html = `<div class="kml-popup"><strong>${escapeHtml(title)}</strong>`;
    if (positionAge) html += `<div class="kml-popup-age">${escapeHtml(positionAge)}</div>`;
    if (gr) html += `<div class="kml-popup-grid">Grid ref: ${escapeHtml(gr)}</div>`;
    else if (hasCoordinates) html += `<div class="kml-popup-grid">Location: ${formatCoordinate(lat)}, ${formatCoordinate(lng)}</div>`;
    html += `<div class="kml-popup-emergency${emergency ? "" : " kml-popup-emergency-clear"}">${emergency ? "EMERGENCY" : "No emergency"}</div>`;
    if (hasCoordinates) {
      const href = mapAppUrl(lat, lng, title);
      html += `<div class="kml-popup-nav"><a href="${escapeHtml(href)}" title="Open location in maps" aria-label="Nav to ${escapeHtml(title)} in maps" target="_blank" rel="noopener">${NAV_ICON} Nav to</a></div>`;
    }
    let details = "";
    if (has("description") && !has("Time")) {
      details += `<div class="kml-popup-desc">${escapeHtml(props.description)}</div>`;
    }
    if (rows.length) {
      details +=
        '<table class="kml-popup-table">' +
        rows
          .map(([l, v]) => `<tr><th>${escapeHtml(l)}</th><td>${escapeHtml(v)}</td></tr>`)
          .join("") +
        "</table>";
    }
    if (etaHtml) details += etaHtml;
    if (details) html += `<details class="kml-popup-details"><summary>More details</summary>${details}</details>`;
    return html + "</div>";
  }

  function formatCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(5) : "";
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
        "_simulationTimeMs": Number(l.simulationTimestamp) || 0,
        "_msgTime": typeof l.textTime === "number" ? l.textTime : (Date.parse(l.textTime) || 0),
        "_msgPos": l.messagePosition || null
      };
      (known ? registered : unregistered).push({
        type: "Feature", properties: props,
        geometry: { type: "Point", coordinates: [l.coordinate.longitude, l.coordinate.latitude] }
      });
    });
    return { registered, unregistered };
  }

  // KML time fields look like "10/30/2026 9:57:12 PM" (UTC in "Time UTC").
  function parseKmlTime(value) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*,?\s*(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec(String(value || "").trim());
    if (m) {
      let h = Number(m[4]) % 12;
      if (/^P/i.test(m[7] || "")) h += 12;
      else if (!m[7]) h = Number(m[4]);
      return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]), Number(m[6]));
    }
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : -1;
  }

  function kmlTimeMs(props) {
    const time = parseKmlTime(props["Time UTC"] || props.timestamp || props.when || props.begin || props.Time || "");
    return time < 0 ? 0 : time;
  }

  function kmlMessageTimeMs(props) {
    return parseKmlTime(props["Message Time"]);
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
      const hasIpcMessage = (p) => hasText(p) || (p && p["Message Type"] && p._msgTime > 0);
      const hasIpc = hasIpcMessage(ip);
      const hasKml = hasText(kp);
      const iMsg = hasIpc ? ip._msgTime || 0 : -1;
      const kMsg = hasKml ? kmlMessageTimeMs(kp) : -1;
      const msgSrc = hasIpc && hasKml
        ? (kMsg > iMsg ? k : i)
        : hasIpc ? i : hasKml ? k : null;
      const props = Object.assign({}, posSrc.properties, { "Map Display Name": key });
      props._positionTimeMs = iPos >= kPos ? iPos : kPos;
      props._simulationTimeMs = posSrc === i ? Number(ip._simulationTimeMs) || 0 : 0;
      delete props._posTime; delete props._msgTime; delete props._msgPos;
      const mp = msgSrc && msgSrc.properties;
      props.Text = ""; props["Message Time"] = ""; props["Message Type"] = "";
      const iLatest = ip ? Math.max(iPos, iMsg) : -1, kLatest = kp ? kPos : -1;
      props["In Emergency"] = (iLatest >= kLatest ? ip : kp)["In Emergency"];
      props["Position source"] = posSrc === i ? "Garmin push" : "MapShare KML";
      if (posSrc === i) fromIpc++; else fromKml++;
      out.push({ type: "Feature", properties: props, geometry: posSrc.geometry });
      if (mp) {
        const viaIpc = msgSrc === i;
        const mpos = viaIpc ? ip._msgPos : null;
        const coords = viaIpc ? (mpos ? [mpos.longitude, mpos.latitude] : null) : msgSrc.geometry.coordinates;
        if (coords) {
          out.push({
            type: "Feature", geometry: { type: "Point", coordinates: coords },
            properties: {
              _isMessage: true, "Map Display Name": key,
              type: (viaIpc ? mp["Message Type"] : "") || "text",
              text: mp.Text,
              time: viaIpc ? mp["Message Time"] : mp["Message Time"] || mp.Time || "",
              timeMs: viaIpc ? ip._msgTime : (kmlMessageTimeMs(mp) >= 0 ? kmlMessageTimeMs(mp) : kmlTimeMs(mp)),
              elevation: viaIpc ? (mpos && mpos.altitude != null ? mpos.altitude + " m" : "") : mp.Elevation || "",
              speed: viaIpc ? (mpos && mpos.speed != null ? mpos.speed + " km/h" : "") : mp.Velocity || "",
              course: viaIpc ? (mpos && mpos.course != null ? mpos.course + "\u00b0" : "") : mp.Course || "",
              source: viaIpc ? "Garmin push" : "MapShare KML"
            }
          });
        }
      }
    });
    return { features: out.concat(others), fromIpc, fromKml };
  }

  let kmlFeaturesCache = [];
  let kmlErrorCache = null;
  let kmlFetchedAt = 0;
  let openKey = null;
  let rebuilding = false;

  // The push feed (a cheap read of the Worker's stored state) is refreshed
  // often so every position report shows; the MapShare KML is fetched on the
  // slower garminPollIntervalMs and its last result reused in between.
  let curMap = null;
  function resizePopupOnDetailsToggle(popup) {
    const element = popup.getElement();
    if (!element) return;
    element.querySelectorAll("details").forEach((details) => {
      details.addEventListener("toggle", () => requestAnimationFrame(() => popup.update()));
    });
  }

  function renderLatestFeatures() {
    if (!curMap) return;
    rebuilding = true;
    if (layerGroup && curMap.hasLayer(layerGroup)) curMap.removeLayer(layerGroup);
    layerGroup = buildLayer({ type: "FeatureCollection", features: latestFeatures });
    layerGroup.on("popupopen", (e) => {
      if (!rebuilding) {
        openKey = Object.keys(layerGroup._keyed).find((k) => layerGroup._keyed[k] === e.popup._source) || null;
      }
      const source = e.popup._source;
      resizePopupOnDetailsToggle(e.popup);
      if (source && source._etaInfo && MaynardEta) MaynardEta.popupOpened(source._etaTeam, source._etaInfo, e.popup);
    });
    layerGroup.on("popupclose", (e) => {
      if (!rebuilding) openKey = null;
      const source = e.popup && e.popup._source;
      if (source && source._etaTeam && MaynardEta) MaynardEta.popupClosed(source._etaTeam);
    });
    if (visible) layerGroup.addTo(curMap);
    rebuilding = false;
    if (visible && openKey && layerGroup._keyed[openKey]) {
      rebuilding = true;
      layerGroup._keyed[openKey].openPopup();
      rebuilding = false;
    }
  }

  function renderIfVisibilityChanged() {
    if (!layerGroup && !latestFeatures.length) return;
    const sig = JSON.stringify(latestFeatures) + "|" + latestFeatures.map((f) => featureIsVisible(f) ? "1" : "0").join("");
    if (sig === lastRawKml) return;
    lastRawKml = sig;
    renderLatestFeatures();
  }

  async function refresh(m0, relayUrl, devices, kmlEveryMs) {
    let ipc = { registered: [], unregistered: [] };
    let ipcError = null;
    const kmlDue = Date.now() - kmlFetchedAt >= (kmlEveryMs || 0) - 500;
    const [ipcRes, kmlRes] = await Promise.allSettled([
      fetchIpc(relayUrl, devices || []),
      kmlDue ? MaynardUtils.fetchText(relayUrl, { timeoutMs: 15000, cache: "no-store" }) : Promise.resolve(null)
    ]);
    if (ipcRes.status === "fulfilled") ipc = ipcRes.value; else ipcError = ipcRes.reason.message;
    if (kmlDue) {
      kmlFetchedAt = Date.now();
      if (kmlRes.status === "fulfilled") {
        try {
          const gj = kmlTextToGeojson(kmlRes.value);
          if (!gj || !gj.features || !gj.features.length) throw new Error("no features returned");
          kmlFeaturesCache = gj.features;
          kmlErrorCache = null;
        } catch (e) { kmlErrorCache = e.message; }
      } else kmlErrorCache = kmlRes.reason.message;
    }
    const kmlError = kmlErrorCache;
    const kmlFeatures = kmlError ? [] : kmlFeaturesCache;

    if (ipcError && kmlError) {
      console.warn("Team position refresh failed (will retry)", ipcError, kmlError);
      MaynardUtils.diag("Garmin", false, "all sources failed: push feed: " + ipcError + "; MapShare KML: " + kmlError);
      MaynardUtils.setStatus("garmin", layerGroup ? "Team positions could not be updated (showing last known)" : "Team positions unavailable");
      renderIfVisibilityChanged();
      return;
    }
    MaynardUtils.setStatus("garmin", null);
    const merged = mergeTeams(ipc.registered, kmlFeatures, devices || []);
    const features = merged.features.concat(ipc.unregistered);
    MaynardUtils.diag("Garmin", !ipcError && !kmlError,
      `newest data per team: ${merged.fromIpc} from push feed, ${merged.fromKml} from MapShare KML` +
      (ipcError ? "; push feed failed: " + ipcError : "") + (kmlError ? "; MapShare KML failed: " + kmlError : "") +
      (ipc.unregistered.length ? "; " + ipc.unregistered.length + " unregistered device(s)" : ""));
    latestFeatures = features;
    renderIfVisibilityChanged();
  }

  function start(map, { relayUrl, pollIntervalMs, pushPollIntervalMs, palette, startVisible, devices, mapDataMaxAgeHours, mode }) {
    markerPalette = MaynardUtils.sanitizePalette(palette);
    curMap = map;
    maxAgeMs = (Number.isFinite(mapDataMaxAgeHours) && mapDataMaxAgeHours > 0 ? mapDataMaxAgeHours : 12) * 60 * 60 * 1000;
    testMode = mode === "test";
    showStaleOverride = testMode && MaynardUtils.showStaleMapDataTestOverride();
    visible = startVisible !== false;
    kmlFetchedAt = 0;
    refresh(map, relayUrl, devices, pollIntervalMs);
    stop();
    const fast = Math.max(5000, Math.min(pushPollIntervalMs || 10000, pollIntervalMs));
    pollTimer = setInterval(() => refresh(map, relayUrl, devices, pollIntervalMs), fast);
  }
  global.addEventListener("storage", (event) => {
    if (!testMode || event.key !== MaynardUtils.STALE_MAP_DATA_TEST_OVERRIDE_KEY) return;
    showStaleOverride = MaynardUtils.showStaleMapDataTestOverride();
    renderIfVisibilityChanged();
  });
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
    curMap = map;
    if (layerGroup && visible) layerGroup.addTo(map);
  }

  global.MaynardKmlMarkers = { start, stop, setVisible, getBounds, reattach, mapAppUrl, gridRef };
})(window);
