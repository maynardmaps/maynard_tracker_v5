// kml-markers.js - "KML Markers": polls the Garmin MapShare feed and renders
// points as markers with popups, refreshed periodically without a page reload.
(function (global) {
  "use strict";

  let layerGroup = null;
  let visible = true;
  let markerColour = "#1565c0";
  let pollTimer = null;
  let lastRawKml = null;

  function buildLayer(geojson) {
    return L.geoJson(geojson, {
      pointToLayer(feature, latlng) {
        return L.circleMarker(latlng, {
          radius: 7,
          color: "#222",
          weight: 1,
          fillColor: markerColour,
          fillOpacity: 0.9
        });
      },
      onEachFeature(feature, layer) {
        const props = feature.properties || {};
        const name = props.name || "Marker";
        const desc = props.description || "";
        layer.bindPopup(
          `<div class="kml-popup"><strong>${escapeHtml(name)}</strong>` +
            (desc ? `<div class="kml-popup-desc">${escapeHtml(desc)}</div>` : "") +
            "</div>"
        );
      }
    });
  }

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
      features.push({
        type: "Feature",
        properties: { name: p.name || "", description: p.description || "" },
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

  function start(map, { feedUrl, proxies, relayUrl, gpsvProxyUrl, pollIntervalMs, colour, startVisible }) {
    const sources = { relayUrl, gpsvProxyUrl };
    markerColour = colour || markerColour;
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

  function setColour(colour, map) {
    markerColour = colour;
    if (layerGroup) {
      layerGroup.eachLayer((l) => l.setStyle && l.setStyle({ fillColor: colour }));
    }
  }

  function getBounds() {
    return layerGroup && layerGroup.getBounds().isValid() ? layerGroup.getBounds() : null;
  }

  function reattach(map) {
    if (layerGroup && visible) layerGroup.addTo(map);
  }

  global.MaynardKmlMarkers = { start, stop, setVisible, setColour, getBounds, reattach };
})(window);
