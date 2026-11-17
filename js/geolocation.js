// geolocation.js - togglable "show my position" marker using the browser
// Geolocation API (works offline-first; just does nothing if denied/unavailable).
(function (global) {
  "use strict";

  let marker = null;
  let accuracyCircle = null;
  let watchId = null;
  let currentMap = null;
  let locationControl = null;
  let locationButton = null;
  let watchGeneration = 0;
  let orientationReading = null;
  let gpsHeading = null;

  function screenAngle() {
    const orientation = global.screen && global.screen.orientation;
    if (orientation && Number.isFinite(orientation.angle)) return orientation.angle;
    return Number.isFinite(global.orientation) ? global.orientation : 0;
  }

  function compassHeading(reading) {
    if (!reading) return null;
    const angle = screenAngle();
    if (Number.isFinite(reading.webkitCompassHeading) && reading.webkitCompassHeading >= 0) {
      return (reading.webkitCompassHeading + angle + 360) % 360;
    }
    if (!reading.absolute || ![reading.alpha, reading.beta, reading.gamma].every(Number.isFinite)) return null;
    const radians = Math.PI / 180;
    const a = reading.alpha * radians, b = reading.beta * radians, g = reading.gamma * radians;
    const s = angle * radians;
    // Project the screen's upward axis into the horizontal east/north plane.
    const east = -Math.sin(a) * Math.cos(b) * Math.cos(s) +
      (Math.cos(a) * Math.cos(g) - Math.sin(a) * Math.sin(b) * Math.sin(g)) * Math.sin(s);
    const north = Math.cos(a) * Math.cos(b) * Math.cos(s) +
      (Math.sin(a) * Math.cos(g) + Math.cos(a) * Math.sin(b) * Math.sin(g)) * Math.sin(s);
    if (Math.hypot(east, north) < 0.01) return null;
    return (Math.atan2(east, north) / radians + 360) % 360;
  }

  function updateHeading() {
    if (!marker || !marker.getElement()) return;
    const arrow = marker.getElement().querySelector(".user-location-heading");
    const compass = compassHeading(orientationReading);
    const heading = compass === null ? gpsHeading : compass;
    arrow.hidden = heading === null;
    if (heading !== null) arrow.style.transform = `rotate(${heading}deg)`;
  }

  function onOrientation(event) {
    if (Number.isFinite(event.webkitCompassHeading) || event.absolute || event.type === "deviceorientationabsolute") {
      orientationReading = {
        webkitCompassHeading: event.webkitCompassHeading,
        absolute: event.absolute || event.type === "deviceorientationabsolute",
        alpha: event.alpha, beta: event.beta, gamma: event.gamma
      };
      updateHeading();
    }
  }

  function startHeading(generation) {
    const OrientationEvent = global.DeviceOrientationEvent;
    if (!OrientationEvent) return;
    function listen() {
      if (generation !== watchGeneration || !currentMap) return;
      global.addEventListener("deviceorientation", onOrientation);
      global.addEventListener("deviceorientationabsolute", onOrientation);
      global.addEventListener("orientationchange", updateHeading);
      if (global.screen && global.screen.orientation && global.screen.orientation.addEventListener) {
        global.screen.orientation.addEventListener("change", updateHeading);
      }
    }
    if (typeof OrientationEvent.requestPermission === "function") {
      try {
        OrientationEvent.requestPermission(true).then((permission) => {
          if (permission === "granted") listen();
          else console.warn("Device orientation permission denied");
        }).catch((err) => { console.warn("Device orientation permission failed", err); });
      } catch (err) {
        console.warn("Device orientation permission failed", err);
      }
    } else {
      listen();
    }
  }

  function stopHeading() {
    global.removeEventListener("deviceorientation", onOrientation);
    global.removeEventListener("deviceorientationabsolute", onOrientation);
    global.removeEventListener("orientationchange", updateHeading);
    if (global.screen && global.screen.orientation && global.screen.orientation.removeEventListener) {
      global.screen.orientation.removeEventListener("change", updateHeading);
    }
    orientationReading = null;
    gpsHeading = null;
  }

  function addLocationControl(map) {
    if (!locationControl) {
      locationControl = L.control({ position: "topleft" });
      locationControl.onAdd = () => {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control-location");
        locationButton = L.DomUtil.create("button", "", container);
        locationButton.type = "button";
        locationButton.setAttribute("aria-label", "Center map on my location");
        locationButton.title = marker ? "Center map on my location" : "Waiting for location";
        locationButton.disabled = !marker;
        locationButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="2"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path></svg>';
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        locationButton.addEventListener("click", () => {
          if (marker && currentMap) currentMap.panTo(marker.getLatLng());
        });
        return container;
      };
    }
    locationControl.addTo(map);
  }

  function start(map) {
    currentMap = map;
    const generation = ++watchGeneration;
    addLocationControl(map);
    if (!("geolocation" in navigator)) {
      console.warn("Geolocation not supported by this browser");
      locationButton.title = "Geolocation is not supported by this browser";
      MaynardUtils.diag("Location", false, locationButton.title);
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (generation !== watchGeneration || !currentMap) return;
        const latlng = [pos.coords.latitude, pos.coords.longitude];
        if (!marker) {
          marker = L.marker(latlng, {
            title: "Your location",
            icon: L.divIcon({
              className: "user-location-icon",
              html: '<div class="user-location-heading" hidden><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 0 15 14 8 11 1 14Z"></path></svg></div><div class="user-location-dot"></div>',
              iconSize: [16, 16]
            })
          }).addTo(currentMap);
          accuracyCircle = L.circle(latlng, {
            radius: pos.coords.accuracy,
            color: "#1565c0",
            weight: 1,
            fillOpacity: 0.1
          }).addTo(currentMap);
        } else {
          marker.setLatLng(latlng);
          accuracyCircle.setLatLng(latlng).setRadius(pos.coords.accuracy);
        }
        gpsHeading = Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0 && pos.coords.heading < 360
          ? pos.coords.heading : null;
        updateHeading();
        locationButton.disabled = false;
        locationButton.title = "Center map on my location";
      },
      (err) => {
        if (generation !== watchGeneration) return;
        console.warn("Geolocation error", err);
        MaynardUtils.diag("Location", false, err.message);
        if (!marker) locationButton.title = `Location unavailable: ${err.message}`;
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    startHeading(generation);
  }

  function stop(map) {
    ++watchGeneration;
    currentMap = null;
    stopHeading();
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (marker && map.hasLayer(marker)) map.removeLayer(marker);
    if (accuracyCircle && map.hasLayer(accuracyCircle)) map.removeLayer(accuracyCircle);
    marker = null;
    accuracyCircle = null;
    if (locationControl) locationControl.remove();
    locationControl = null;
    locationButton = null;
  }

  function reattach(map) {
    currentMap = map;
    addLocationControl(map);
    if (marker) marker.addTo(map);
    if (accuracyCircle) accuracyCircle.addTo(map);
    updateHeading();
  }

  global.MaynardGeolocation = { start, stop, reattach };
})(window);
