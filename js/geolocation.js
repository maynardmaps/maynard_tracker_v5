// geolocation.js - togglable "show my position" marker using the browser
// Geolocation API (works offline-first; just does nothing if denied/unavailable).
(function (global) {
  "use strict";

  let marker = null;
  let accuracyCircle = null;
  let watchId = null;

  function start(map) {
    if (!("geolocation" in navigator)) {
      console.warn("Geolocation not supported by this browser");
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const latlng = [pos.coords.latitude, pos.coords.longitude];
        if (!marker) {
          marker = L.marker(latlng, {
            title: "Your location",
            icon: L.divIcon({
              className: "user-location-icon",
              html: '<div class="user-location-dot"></div>',
              iconSize: [16, 16]
            })
          }).addTo(map);
          accuracyCircle = L.circle(latlng, {
            radius: pos.coords.accuracy,
            color: "#1565c0",
            weight: 1,
            fillOpacity: 0.1
          }).addTo(map);
        } else {
          marker.setLatLng(latlng);
          accuracyCircle.setLatLng(latlng).setRadius(pos.coords.accuracy);
        }
      },
      (err) => { console.warn("Geolocation error", err); MaynardUtils.diag("Location", false, err.message); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
  }

  function stop(map) {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (marker && map.hasLayer(marker)) map.removeLayer(marker);
    if (accuracyCircle && map.hasLayer(accuracyCircle)) map.removeLayer(accuracyCircle);
    marker = null;
    accuracyCircle = null;
  }

  function reattach(map) {
    if (marker) marker.addTo(map);
    if (accuracyCircle) accuracyCircle.addTo(map);
  }

  global.MaynardGeolocation = { start, stop, reattach };
})(window);
