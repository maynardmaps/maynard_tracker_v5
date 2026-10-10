// routes.js - loads KML/GPX routes for the selected sub-folder, colours them,
// and exposes per-route toggles.
(function (global) {
  "use strict";

  let currentFolder = null;
  let routeLayers = new Map(); // filename -> L.Layer (added to map when visible)
  let onChangeCb = null;

  function fileExt(name) {
    return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  }

  function loadFile(folder, filename) {
    const url = `routes/${folder}/${filename}`;
    const ext = fileExt(filename);
    return new Promise((resolve, reject) => {
      const style = () => ({ color: "#3388ff", weight: 4, opacity: 0.85 });
      let layer;
      if (ext === "gpx") {
        layer = omnivore.gpx(url, null, L.geoJson(null, { style }));
      } else if (ext === "kml") {
        layer = omnivore.kml(url, null, L.geoJson(null, { style }));
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
  function splitFile(filename, fileLayer) {
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
      groups.set(key, { layers: [l], base: nameOf(l).replace(/\s+(path|route|track)$/i, "") });
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
      groups.set(lines.length ? `${filename} (points)` : filename, { layers: orphans });
    }
    return [...groups.entries()].map(([key, g]) => [key, L.featureGroup(g.layers)]);
  }

  // Loads every file in `folder`, splits multi-route files into separate
  // entries, colours each per `routeColours` overrides, and returns a Map of
  // route key -> { layer, colour, visible }.
  async function loadFolder(folder, manifest, routeColourOverrides) {
    currentFolder = folder;
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
      entries.push(...splitFile(filenames[i], result.value));
    });

    const colours = MaynardUtils.assignColours(entries.map(([k]) => k), routeColourOverrides);
    entries.forEach(([key, layer]) => {
      const colour = colours.get(key);
      layer.setStyle({ color: colour, weight: 4, opacity: 0.85 });
      routeLayers.set(key, { layer, colour, visible: true });
    });

    return routeLayers;
  }

  function attachToMap(map) {
    routeLayers.forEach(({ layer, visible }) => {
      if (visible) layer.addTo(map);
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
    } else if (map.hasLayer(entry.layer)) {
      map.removeLayer(entry.layer);
    }
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

  function getCurrentFolder() {
    return currentFolder;
  }

  global.MaynardRoutes = {
    loadFolder, attachToMap, detachFromMap, setVisible, getBounds, getLayers, getCurrentFolder
  };
})(window);
