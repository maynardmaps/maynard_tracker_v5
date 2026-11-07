// nearby-picker.js - lets users choose among nearby map features.
(function (global) {
  "use strict";

  const PICK_RADIUS_PX = 36;
  const entries = new Set();
  const registered = new WeakSet();
  let map = null;

  MaynardMapCore.onMapReady((readyMap) => { map = readyMap; });

  function showPicker(latlng, nearby) {
    const content = document.createElement("div");
    content.className = "nearby-picker";
    content.setAttribute("aria-label", "Choose a nearby map item");

    const heading = document.createElement("strong");
    heading.textContent = `${nearby.length} nearby map items`;
    content.appendChild(heading);

    const list = document.createElement("div");
    list.className = "nearby-picker-list";
    nearby.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nearby-picker-item";
      const category = document.createElement("span");
      category.className = "nearby-picker-category";
      category.textContent = entry.category;
      const label = document.createElement("span");
      label.className = "nearby-picker-label";
      label.textContent = entry.label;
      button.append(category, label);
      button.addEventListener("click", () => {
        map.closePopup();
        entry.layer.openPopup();
      });
      list.appendChild(button);
    });
    content.appendChild(list);

    L.popup({ maxWidth: 280, maxHeight: 260, autoPan: true, className: "nearby-picker-popup" })
      .setLatLng(latlng)
      .setContent(content)
      .openOn(map);
    const firstButton = content.querySelector("button");
    if (firstButton) firstButton.focus();
  }

  function register(layer, category, label) {
    if (!layer || registered.has(layer)) return;
    registered.add(layer);
    const entry = { layer, category, label };
    if (layer._map) entries.add(entry);
    layer.on("add", () => entries.add(entry));
    layer.on("remove", () => entries.delete(entry));

    layer.on("click", (event) => {
      const activeMap = map;
      if (!activeMap) return;
      setTimeout(() => {
        if (map !== activeMap || !activeMap.hasLayer(layer)) return;
        const clickPoint = activeMap.latLngToContainerPoint(event.latlng);
        const nearby = [...entries].filter((candidate) => {
          if (candidate.layer._map !== activeMap || !candidate.layer.getLatLng) return false;
          const point = activeMap.latLngToContainerPoint(candidate.layer.getLatLng());
          return clickPoint.distanceTo(point) <= PICK_RADIUS_PX;
        });
        if (nearby.length < 2) return;
        activeMap.closePopup();
        showPicker(event.latlng, nearby);
      }, 0);
    });
  }

  global.MaynardNearbyPicker = { register };
})(window);
