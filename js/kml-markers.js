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
      "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs",
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

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  // Converts the GPS Visualizer xml-json proxy output (a JSON rendering of the
  // KML) into the same GeoJSON shape toGeoJSON.kml produces.
  function gpsvJsonToGeojson(json) {
    const doc = json && json.kml && json.kml.Document;
    if (!doc) throw new Error("Unexpected GPS Visualizer response");
    const placemarks = [];
    const collect = (node) => {
      asArray(node.Placemark).forEach((p) => placemarks.push(p));
      asArray(node.Folder).forEach(collect);
    };
    collect(doc);

    const parseCoords = (str) =>
      String(str || "")
        .trim()
        .split(/\s+/)
        .map((c) => c.split(",").map(Number))
        .filter((c) => c.length >= 2 && isFinite(c[0]) && isFinite(c[1]));

    const features = [];
    placemarks.forEach((p) => {
      let geometry = null;
      if (p.Point) {
        const c = parseCoords(p.Point.coordinates)[0];
        if (c) geometry = { type: "Point", coordinates: c };
      } else if (p.LineString) {
        const cs = parseCoords(p.LineString.coordinates);
        if (cs.length > 1) geometry = { type: "LineString", coordinates: cs };
        else if (cs.length === 1) geometry = { type: "Point", coordinates: cs[0] };
      }
      if (!geometry) return;
      const properties = { name: p.name || "", description: p.description || "" };
      asArray(p.ExtendedData && p.ExtendedData.Data).forEach((d) => {
        if (d && d.name != null) properties[d.name] = d.value == null ? "" : String(d.value);
      });
      if (p.TimeStamp && p.TimeStamp.when) properties.timestamp = p.TimeStamp.when;
      features.push({
        type: "Feature",
        properties,
        geometry
      });
    });
    return { type: "FeatureCollection", features };
  }

  function kmlTextToGeojson(kmlText) {
    const xml = new DOMParser().parseFromString(kmlText, "text/xml");
    return toGeoJSON.kml(xml);
  }

  // Source order: Cloudflare Worker relay -> GPS Visualizer proxy (JSON) ->
  // generic public CORS proxies. A source that errors or yields no features
  // falls through to the next. Returns { raw, geojson }.
  async function fetchFeed(feedUrl, proxies, sources) {
    const attempts = [];
    if (sources.relayUrl) {
      attempts.push(["Garmin relay", async () => {
        const raw = await MaynardUtils.fetchText(sources.relayUrl, { timeoutMs: 15000, cache: "no-store" });
        return { raw, geojson: kmlTextToGeojson(raw) };
      }]);
    }
    if (sources.gpsvProxyUrl) {
      attempts.push(["GPS Visualizer proxy", async () => {
        const raw = await MaynardUtils.fetchText(sources.gpsvProxyUrl + encodeURIComponent(feedUrl), { timeoutMs: 20000 });
        return { raw, geojson: gpsvJsonToGeojson(JSON.parse(raw)) };
      }]);
    }
    attempts.push(["public CORS proxies", async () => {
      const raw = await MaynardUtils.fetchViaCorsProxies(feedUrl, proxies, { timeoutMs: 15000 });
      return { raw, geojson: kmlTextToGeojson(raw) };
    }]);

    let lastErr;
    for (const [label, run] of attempts) {
      try {
        const result = await run();
        if (!result.geojson || !result.geojson.features || !result.geojson.features.length) {
          throw new Error("no features returned");
        }
        return result;
      } catch (e) {
        lastErr = e;
        console.warn(`Garmin feed via ${label} failed, trying next source`, e);
      }
    }
    throw lastErr;
  }

  async function fetchAndParse(feedUrl, proxies, sources) {
    const { raw, geojson } = await fetchFeed(feedUrl, proxies, sources);
    if (raw === lastRawKml) return null; // no change since last poll
    lastRawKml = raw;
    return geojson;
  }

  async function refresh(map, feedUrl, proxies, sources) {
    try {
      const geojson = await fetchAndParse(feedUrl, proxies, sources);
      if (!geojson) return; // unchanged
      if (layerGroup && map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
      layerGroup = buildLayer(geojson);
      if (visible) layerGroup.addTo(map);
    } catch (e) {
      console.warn("KML marker refresh failed (will retry)", e);
    }
  }

  function start(map, { feedUrl, proxies, relayUrl, gpsvProxyUrl, pollIntervalMs, palette, startVisible }) {
    const sources = { relayUrl, gpsvProxyUrl };
    markerPalette = MaynardUtils.sanitizePalette(palette);
    visible = startVisible !== false;
    refresh(map, feedUrl, proxies, sources);
    stop();
    pollTimer = setInterval(() => refresh(map, feedUrl, proxies, sources), pollIntervalMs);
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
