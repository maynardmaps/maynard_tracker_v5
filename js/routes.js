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

  // Loads every file in `folder` (per routes/manifest.json), colours each
  // alphanumerically per `routeColours` overrides, and returns a Map of
  // filename -> { layer, colour, visible }.
  async function loadFolder(folder, manifest, routeColourOverrides) {
    currentFolder = folder;
    routeLayers = new Map();
    const filenames = manifest.folders[folder] || [];
    const colours = MaynardUtils.assignColours(filenames, routeColourOverrides);

    const results = await Promise.allSettled(
      filenames.map((f) => loadFile(folder, f))
    );

    results.forEach((result, i) => {
      const filename = filenames[i];
      if (result.status !== "fulfilled") {
        console.error(`Route "${filename}" failed to load`, result.reason);
        return;
      }
      const layer = result.value;
      const colour = colours.get(filename);
      layer.setStyle({ color: colour, weight: 4, opacity: 0.85 });
      routeLayers.set(filename, { layer, colour, visible: true });
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
