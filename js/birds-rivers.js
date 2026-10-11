// birds-rivers.js - loads the static "birds and rivers" KML file (points and
// polygons) from the data/ folder and renders it as a togglable overlay.
// Unlike kml-markers.js (Garmin feed), this file is static/version-controlled
// so it's loaded once rather than polled.
(function (global) {
  "use strict";

  const POINT_COLOUR = "#8d5524"; // birds
  const POLYGON_COLOUR = "#1e88e5"; // rivers/wetlands

  let layer = null;
  let visible = false;
  let loadPromise = null;

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function bindPopup(feature, l) {
    const props = feature.properties || {};
    const name = props.name || "Feature";
    const desc = props.description || "";
    l.bindPopup(
      `<div class="kml-popup"><strong>${escapeHtml(name)}</strong>` +
        (desc ? `<div class="kml-popup-desc">${escapeHtml(desc)}</div>` : "") +
        "</div>"
    );
  }

  function buildLayer(url) {
    return new Promise((resolve, reject) => {
      const geoLayer = omnivore.kml(url, null, L.geoJson(null, {
        pointToLayer(feature, latlng) {
          return L.circleMarker(latlng, {
            radius: 7,
            color: "#222",
            weight: 0.5,
            fillColor: POINT_COLOUR,
            fillOpacity: 0.9
          });
        },
        style(feature) {
          if (feature.geometry && feature.geometry.type.indexOf("Polygon") !== -1) {
            return { color: POLYGON_COLOUR, weight: 0.5, fillColor: POLYGON_COLOUR, fillOpacity: 0.25 };
          }
          return { color: "#3388ff", weight: 1 };
        },
        onEachFeature: bindPopup
      }));
      geoLayer.on("ready", () => resolve(geoLayer));
      geoLayer.on("error", (e) => reject(e.error || new Error(`Failed to load ${url}`)));
    });
  }

  // Loads every KML file; one failing file does not hide the others.
  async function buildAll(urls) {
    const group = L.featureGroup();
    const results = await Promise.all(urls.map((u) => buildLayer(u).catch((e) => { console.error("Birds and rivers KML failed: " + u, e); return null; })));
    results.forEach((l) => l && group.addLayer(l));
    return group;
  }

  // Loads the KML files once (cached) and shows/hides it on `map`.
  async function init(map, { urls, startVisible }) {
    visible = startVisible === true;
    if (!loadPromise) {
      loadPromise = buildAll(urls).catch((e) => {
        console.error("Birds and rivers KML failed to load", e);
        loadPromise = null; // allow a retry on next init/reattach
        return null;
      });
    }
    layer = await loadPromise;
    if (layer && visible) layer.addTo(map);
    return layer;
  }

  function setVisible(v, map) {
    visible = v;
    if (!layer) return;
    if (visible) layer.addTo(map);
    else if (map.hasLayer(layer)) map.removeLayer(layer);
  }

  function reattach(map) {
    if (layer && visible) layer.addTo(map);
  }

  function getBounds() {
    return layer && layer.getBounds().isValid() ? layer.getBounds() : null;
  }

  global.MaynardBirdsRivers = { init, setVisible, reattach, getBounds };
})(window);
