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
        return L.marker(latlng, { icon: L.divIcon({
          className: "team-diamond",
          html: `<span style="background:${c}"></span>`,
          iconSize: [18, 18], iconAnchor: [9, 9]
        }) });
      },
      onEachFeature(feature, layer) {
        layer.bindPopup(buildPopupHtml(feature.properties || {}), { maxWidth: 320 });
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

  function buildPopupHtml(props) {
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

  global.MaynardKmlMarkers = { start, stop, setVisible, getBounds, reattach };
})(window);
