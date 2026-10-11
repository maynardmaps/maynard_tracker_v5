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

  function buildLayer(geojson) {
    // Each point marker gets the next palette slot in alphanumerical order of
    // its display name; slots repeat after the palette is exhausted.
    const keys = [...new Set(
      geojson.features
        .filter((f) => f.geometry && f.geometry.type === "Point")
        .map(markerKey)
    )];
    const colours = MaynardUtils.assignColours(keys, markerPalette);
    return L.geoJson(geojson, {
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
  }

  // Fields shown first, in this order; any other non-empty KML field follows.
  const POPUP_FIELDS = [
    ["Time", "Time"],
    ["Time UTC", "Time (UTC)"],
    ["Text", "Message"],
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
  const POPUP_HIDDEN = new Set(["Map Display Name", "SpatialRefSystem", "Incident Id", "Device Identifier"]);

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
      if (!shown.has(k) && !POPUP_HIDDEN.has(k) && !EXCLUDED_PROPS.has(k)) add(k, k);
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

  // The Garmin feed is only fetched via the Cloudflare Worker relay.
  async function fetchAndParse(relayUrl) {
    const raw = await MaynardUtils.fetchText(relayUrl, { timeoutMs: 15000, cache: "no-store" });
    if (raw === lastRawKml) return null; // no change since last poll
    const geojson = kmlTextToGeojson(raw);
    if (!geojson || !geojson.features || !geojson.features.length) throw new Error("no features returned");
    lastRawKml = raw;
    return geojson;
  }
  async function refresh(map, relayUrl) {
    try {
      const geojson = await fetchAndParse(relayUrl);
      MaynardUtils.setStatus("garmin", null);
      if (!geojson) return; // unchanged
      if (layerGroup && map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
      layerGroup = buildLayer(geojson);
      if (visible) layerGroup.addTo(map);
    } catch (e) {
      console.warn("KML marker refresh failed (will retry)", e);
      MaynardUtils.setStatus("garmin", layerGroup ? "Team positions could not be updated (showing last known)" : "Team positions unavailable");
    }
  }

  function start(map, { relayUrl, pollIntervalMs, palette, startVisible }) {
    markerPalette = MaynardUtils.sanitizePalette(palette);
    visible = startVisible !== false;
    refresh(map, relayUrl);
    stop();
    pollTimer = setInterval(() => refresh(map, relayUrl), pollIntervalMs);
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
