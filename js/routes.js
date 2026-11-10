// routes.js - loads KML/GPX routes for the selected sub-folder, colours them,
// and exposes per-route toggles.
(function (global) {
  "use strict";

  let routeLayers = new Map(); // filename -> L.Layer (added to map when visible)

  function fileExt(name) {
    return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  }

  function loadFile(folder, filename) {
    const url = `routes/${folder}/${filename}`;
    const ext = fileExt(filename);
    return new Promise((resolve, reject) => {
      const style = () => ({ color: "#3388ff", weight: 4, opacity: 0.85 });
      let layer;
      const pointToLayer = (f, ll) => {
        const point = L.circleMarker(ll, {
          radius: 4,
          weight: 1,
          color: "#fff",
          fillColor: "#3388ff",
          fillOpacity: 1,
          interactive: false,
          keyboard: false,
          bubblingMouseEvents: false
        });
        const name = String((f.properties && f.properties.name) || filename);
        point.bindTooltip(document.createTextNode(name), {
          direction: "top",
          offset: [0, -4],
          className: "route-point-tooltip"
        });
        return point;
      };
      if (ext === "gpx") {
        layer = omnivore.gpx(url, null, L.geoJson(null, { style, pointToLayer }));
      } else if (ext === "kml") {
        layer = omnivore.kml(url, null, L.geoJson(null, { style, pointToLayer }));
      } else {
        reject(new Error(`Unsupported route file type: ${filename}`));
        return;
      }
      layer.on("ready", () => resolve(layer));
      layer.on("error", (e) => reject(e.error || new Error(`Failed to load ${filename}`)));
    });
  }

  const isLine = (l) => l.feature && /LineString/.test(l.feature.geometry && l.feature.geometry.type);

  // Splits one loaded file into separate routes: each line feature (KML path
  // placemark, GPX track or route) becomes its own entry. Point features are
  // attached to the route whose name prefixes theirs ("X SP" -> "X Path"),
  // otherwise they are grouped as "<file> (points)".
  function splitFile(folder, filename, fileLayer) {
    const lines = [];
    const points = [];
    fileLayer.eachLayer((l) => (isLine(l) ? lines : points).push(l));
    const nameOf = (l) => ((l.feature && l.feature.properties && l.feature.properties.name) || "").trim();
    const groups = new Map();
    const usedKeys = new Set();
    lines.forEach((l, i) => {
      let key = lines.length === 1 ? filename : `${filename}: ${nameOf(l) || `route ${i + 1}`}`;
      while (usedKeys.has(key)) key += "'";
      usedKeys.add(key);
      groups.set(key, { layers: [l], base: nameOf(l).replace(/\s+(path|route|track)$/i, ""), id: `${folder}/${filename}#${i}` });
    });
    const orphans = [];
    points.forEach((p) => {
      const n = nameOf(p);
      let target = null;
      groups.forEach((g) => {
        if (g.base && n.toLowerCase().startsWith(g.base.toLowerCase() + " ")) target = g;
      });
      if (target) target.layers.push(p);
      else orphans.push(p);
    });
    if (orphans.length) {
      groups.set(lines.length ? `${filename} (points)` : filename, { layers: orphans, id: null });
    }
    return [...groups.entries()].map(([key, g]) => [key, L.featureGroup(g.layers), g.id]);
  }

  // Loads every file in `folder`, splits multi-route files into separate
  // entries, colours each from the generic route palette (cycling), and
  // returns a Map of
  // route key -> { layer, colour, visible }.
  async function loadFolder(folder, manifest, routePalette) {
    routeLayers = new Map();
    const filenames = manifest.folders[folder] || [];

    const results = await Promise.allSettled(
      filenames.map((f) => loadFile(folder, f))
    );

    const entries = [];
    results.forEach((result, i) => {
      if (result.status !== "fulfilled") {
        console.error(`Route "${filenames[i]}" failed to load`, result.reason);
        return;
      }
      entries.push(...splitFile(folder, filenames[i], result.value));
    });

    const colours = MaynardUtils.assignColours(entries.map(([k]) => k), routePalette);
    entries.forEach(([key, layer, id]) => {
      const colour = colours.get(key);
      layer.setStyle({ color: colour, weight: 4, opacity: 0.85, fillColor: colour });
      const pointLayers = [];
      layer.eachLayer((l) => {
        if (!(l instanceof L.CircleMarker)) return;
        l.setStyle({ color: "#fff", weight: 1, fillColor: colour, fillOpacity: 1 });
        pointLayers.push(l);
      });
      routeLayers.set(key, { layer, colour, visible: true, id, pointLayers, pointLabelsVisible: false });
    });

    return routeLayers;
  }

  function attachToMap(map) {
    routeLayers.forEach((entry) => {
      if (entry.visible) {
        entry.layer.addTo(map);
        setPointLabelsVisible(entry, entry.pointLabelsVisible);
      }
    });
  }

  function detachFromMap(map) {
    routeLayers.forEach(({ layer }) => {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function setVisible(filename, visible, map) {
    const entry = routeLayers.get(filename);
    if (!entry) return;
    entry.visible = visible;
    if (visible) {
      entry.layer.addTo(map);
      setPointLabelsVisible(entry, entry.pointLabelsVisible);
    } else if (map.hasLayer(entry.layer)) {
      map.removeLayer(entry.layer);
    }
  }

  function setPointLabelsVisible(entry, visible) {
    entry.pointLabelsVisible = visible;
    entry.pointLayers.forEach((point) => {
      if (point._map) {
        if (visible) point.openTooltip();
        else point.closeTooltip();
      }
    });
  }

  function setLabelsVisible(filename, visible) {
    const entry = routeLayers.get(filename);
    if (entry) setPointLabelsVisible(entry, visible);
  }

  function getBounds() {
    let bounds = null;
    routeLayers.forEach(({ layer, visible }) => {
      if (!visible) return;
      const b = layer.getBounds ? layer.getBounds() : null;
      if (b && b.isValid()) {
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      }
    });
    return bounds;
  }

  function getLayers() {
    return routeLayers;
  }

  global.MaynardRoutes = {
    loadFolder, attachToMap, detachFromMap, setVisible, setLabelsVisible, getBounds, getLayers
  };
})(window);
