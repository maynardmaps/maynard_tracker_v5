// position-share.js - GPS-based position sharing: enables users to share
// their location with others viewing the map. Handles geolocation polling,
// position updates to the Worker, marker display, and auto-stop timer.
// PHASE 1 UPDATE: Integrated with polling coordinator and GPS backoff strategy
(function (global) {
  "use strict";

  let settings = {};
  let map = null;
  let layerGroup = null;
  let isEnabled = false;
  let pageVisible = true;
  let autoStopTimer = null;
  let sessionId = null;
  let lastUpdateMs = 0;
  let lastShareSuccessMs = 0;
  let userDisplayName = "";
  let markerCache = new Map(); // sessionId -> marker
  let gpsBackoff = null;
  let pollingSubscriptionId = null;
  let markerRefreshSubscriptionId = null;
  let statusCallback = null; // For UI feedback
  let sharingGeneration = 0;
  let positionRequestInFlight = false;
  let positionRequestQueued = false;

  const POSITION_SHARE_NAME_KEY = "maynard_position_share_name";
  const POSITION_SHARE_ID_KEY = "maynard_position_share_id";

  function loadOrCreateSessionId() {
    let id = localStorage.getItem(POSITION_SHARE_ID_KEY);
    if (id && /^[a-f0-9]{32}$/.test(id)) return id;
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(POSITION_SHARE_ID_KEY, id);
    return id;
  }

  function init(newMap, newSettings) {
    map = newMap;
    settings = newSettings;
    if (!layerGroup) {
      layerGroup = L.featureGroup([]).addTo(map);
    }
    if (markerRefreshSubscriptionId === null) {
      markerRefreshSubscriptionId = MaynardPollingCoordinator.subscribe(() => {
        refreshMarkers();
      }, 10000);
    }
    // Monitor page visibility to avoid polling when backgrounded
    document.addEventListener("visibilitychange", () => {
      pageVisible = !document.hidden;
      if (!isEnabled) return;
      if (pageVisible) {
        // Reactivate polling when page becomes visible
        updatePollingInterval();
      } else {
        // Pause GPS polling when backgrounded
        updatePollingInterval();
      }
    });
  }

  function getLastShareStatus() {
    if (!isEnabled) {
      return { status: "disabled", message: "Position sharing not enabled" };
    }
    if (lastShareSuccessMs === 0) {
      return { status: "pending", message: "Waiting for first position..." };
    }
    const age = Date.now() - lastShareSuccessMs;
    const minutes = Math.floor(age / 60000);
    const seconds = Math.floor((age % 60000) / 1000);
    let timeStr;
    if (minutes > 0) {
      timeStr = `${minutes}m ${seconds}s ago`;
    } else {
      timeStr = `${seconds}s ago`;
    }
    return { status: "ok", message: `Last shared: ${timeStr}` };
  }

  // Persist display name to localStorage
  function saveDisplayName(name) {
    try {
      localStorage.setItem(POSITION_SHARE_NAME_KEY, name);
    } catch (e) {
      console.warn("Could not save position share name", e);
    }
  }

  function loadDisplayName() {
    try {
      return localStorage.getItem(POSITION_SHARE_NAME_KEY) || "";
    } catch (e) {
      console.warn("Could not load position share name", e);
      return "";
    }
  }

  function updatePollingInterval() {
    if (!isEnabled || !gpsBackoff) return;

    // Get base interval from settings
    const updateMinutes = settings.positionShare?.updateMinutes || 5;
    const baseIntervalMs = updateMinutes * 60 * 1000;

    // Apply backoff strategy
    const backoffIntervalMs = gpsBackoff.getNextRetryDelayMs();

    // If page is hidden, pause GPS polling (still fetch marker updates)
    const gpsIntervalMs = pageVisible && isEnabled ? backoffIntervalMs : 0;

    if (pollingSubscriptionId !== null) {
      MaynardPollingCoordinator.updateInterval(pollingSubscriptionId, gpsIntervalMs);
    }
  }

  function enable(displayName) {
    if (isEnabled) return false;
    if (!("geolocation" in navigator)) {
      console.error("Geolocation not supported");
      return false;
    }

    userDisplayName = displayName.trim().substring(0, 4);
    if (!userDisplayName) {
      console.error("Display name required");
      return false;
    }
    saveDisplayName(userDisplayName);

    try {
      sessionId = loadOrCreateSessionId();
    } catch (err) {
      console.error("Could not initialize position sharing identity:", err);
      if (statusCallback) statusCallback({ status: "error", message: "Position sharing requires browser storage and secure random numbers." });
      return false;
    }

    isEnabled = true;
    sharingGeneration++;
    pageVisible = !document.hidden;

    // Initialize GPS backoff tracker (5 minute default, 60 minute max)
    const updateMinutes = settings.positionShare?.updateMinutes || 5;
    gpsBackoff = MaynardUtils.createGpsBackoffTracker(
      updateMinutes * 60 * 1000,
      60 * 60 * 1000
    );

    // Subscribe GPS position requests to coordinator
    pollingSubscriptionId = MaynardPollingCoordinator.subscribe(() => {
      if (isEnabled && pageVisible) {
        requestPositionOnce();
      }
    }, gpsBackoff.getNextRetryDelayMs());

    // Auto-stop timer
    const autoStopHours = settings.positionShare?.autoStopHours || 8;
    if (autoStopTimer) clearTimeout(autoStopTimer);
    autoStopTimer = setTimeout(() => {
      console.warn("Position sharing auto-stopped after", autoStopHours, "hours");
      disable();
    }, autoStopHours * 60 * 60 * 1000);

    return true;
  }

  function disable() {
    isEnabled = false;
    sharingGeneration++;
    positionRequestQueued = false;
    userDisplayName = "";
    sessionId = null;

    // Unsubscribe from coordinator
    if (pollingSubscriptionId !== null) {
      MaynardPollingCoordinator.unsubscribe(pollingSubscriptionId);
      pollingSubscriptionId = null;
    }
    if (autoStopTimer !== null) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }

    gpsBackoff = null;
  }

  // Request GPS position once with timeout and backoff tracking
  function requestPositionOnce(callback) {
    if (!isEnabled) return;
    if (positionRequestInFlight) {
      positionRequestQueued = true;
      return;
    }
    positionRequestInFlight = true;
    const generation = sharingGeneration;
    const finish = () => {
      positionRequestInFlight = false;
      if (positionRequestQueued && isEnabled && pageVisible) {
        positionRequestQueued = false;
        requestPositionOnce();
      } else {
        positionRequestQueued = false;
      }
    };

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (!isEnabled || generation !== sharingGeneration) {
          finish();
          return;
        }
        try {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const timestamp = Date.now();

          lastUpdateMs = timestamp;
          // Record success for backoff strategy
          if (gpsBackoff) {
            gpsBackoff.recordSuccess();
            updatePollingInterval(); // Adjust interval based on backoff state
          }

          // Record success with connection monitor
          MaynardConnectionMonitor.recordAttempt(true);

          if (callback) callback();
          await sendPositionToWorker(lat, lng, timestamp, pos.coords.accuracy, generation);
        } finally {
          finish();
        }
      },
      (err) => {
        if (!isEnabled || generation !== sharingGeneration) {
          finish();
          return;
        }
        try {
          console.warn("Geolocation error:", err.message);

          // Record failure for backoff strategy
          if (gpsBackoff) {
            gpsBackoff.recordFailure();
            updatePollingInterval(); // Adjust interval based on backoff state
          }

          // Record failure with connection monitor
          MaynardConnectionMonitor.recordAttempt(false);

          if (callback) callback();
        } finally {
          finish();
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30000 // 30 second timeout
      }
    );
  }

  // Legacy sharePosition - not used anymore, keeping for compatibility
  function sharePosition() {
    requestPositionOnce();
  }

  async function sendPositionToWorker(lat, lng, timestamp, accuracy, generation) {
    if (!userDisplayName) return;

    try {
      const relayUrl = (window.MAYNARD_CONFIG?.garminRelayUrl || "").replace(/\/$/, "");
      const response = await fetch(`${relayUrl}/positions/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: lat,
          longitude: lng,
          name: userDisplayName,
          timestamp,
          accuracy,
          sessionId
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      if (!isEnabled || generation !== sharingGeneration) return;
      // Track successful share
      lastShareSuccessMs = timestamp;
      if (statusCallback) {
        statusCallback(getLastShareStatus());
      }
    } catch (err) {
      console.error("Failed to share position:", err.message);
      if (statusCallback && isEnabled && generation === sharingGeneration) {
        statusCallback({ status: "error", message: `Share failed: ${err.message}` });
      }
    }
  }

  function positionPopupHtml(pos, age) {
    const elapsedSec = Math.floor(age / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedHour = Math.floor(elapsedMin / 60);
    let timeStr;
    if (elapsedHour > 0) {
      timeStr = `${elapsedHour}h ${elapsedMin % 60}m ago`;
    } else if (elapsedMin > 0) {
      timeStr = `${elapsedMin}m ago`;
    } else {
      timeStr = `${elapsedSec}s ago`;
    }

    const gridRef = MaynardKmlMarkers.gridRef(pos.latitude, pos.longitude);
    const location = gridRef
      ? `Grid ref: ${escapeHtml(gridRef)}`
      : `Location: ${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`;
    const accuracy = Number.isFinite(pos.accuracy) && pos.accuracy >= 0
      ? `${Math.ceil(pos.accuracy)} m`
      : "unavailable";
    return `
      <div class="position-share-popup">
        <strong>${escapeHtml(pos.name)}</strong>
        <div class="popup-row">Time: ${escapeHtml(timeStr)}</div>
        <div class="popup-row">${location}</div>
        <div class="popup-row">Accuracy: ${accuracy}</div>
        ${MaynardKmlMarkers.navigationHtml(pos.latitude, pos.longitude, pos.name)}
      </div>
    `;
  }

  // Fetch positions from the Worker and update markers
  async function refreshMarkers() {
    if (!map) return;

    try {
      const relayUrl = (window.MAYNARD_CONFIG?.garminRelayUrl || "").replace(/\/$/, "");
      const response = await fetch(`${relayUrl}/positions`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const positions = data.positions || [];
      const persistenceMs = (settings.positionShare?.persistenceMinutes || 20) * 60 * 1000;
      const now = Date.now();

      // Update existing markers and add new ones
      const seenSessions = new Set();
      positions.forEach((pos) => {
        // Skip if expired
        const age = now - pos.timestamp;
        if (age > persistenceMs) {
          return;
        }
        seenSessions.add(pos.sessionId);

        const existing = markerCache.get(pos.sessionId);
        if (existing && existing._positionShareName !== pos.name) {
          layerGroup.removeLayer(existing);
          markerCache.delete(pos.sessionId);
        }
        // Update or create marker
        if (!markerCache.has(pos.sessionId)) {
          const marker = L.marker([pos.latitude, pos.longitude], {
            icon: L.divIcon({
              className: "position-share-marker",
              html: `<div class="share-marker-icon"><span class="share-marker-label">${escapeHtml(pos.name)}</span></div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 15],
              popupAnchor: [0, -15]
            }),
            title: pos.name
          });
          marker._positionShareName = pos.name;

          marker.bindPopup(positionPopupHtml(pos, age));
          MaynardNearbyPicker.register(marker, "Shared position", pos.name);
          marker.addTo(layerGroup);
          markerCache.set(pos.sessionId, marker);
        } else {
          // Update existing marker
          const marker = markerCache.get(pos.sessionId);
          marker.setLatLng([pos.latitude, pos.longitude]);
          marker.setPopupContent(positionPopupHtml(pos, age));
        }
      });

      // Remove markers that are no longer in the list
      for (const [sessionId, marker] of markerCache.entries()) {
        if (!seenSessions.has(sessionId)) {
          layerGroup.removeLayer(marker);
          markerCache.delete(sessionId);
        }
      }
    } catch (err) {
      console.error("Failed to refresh position markers:", err.message);
    }
  }

  function reattach(newMap) {
    map = newMap;
    if (layerGroup && map.hasLayer(layerGroup)) {
      // Already attached
      return;
    }
    if (layerGroup) {
      layerGroup.addTo(map);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  global.MaynardPositionShare = {
    init,
    enable,
    disable,
    loadDisplayName,
    saveDisplayName,
    isEnabled: () => isEnabled,
    getLastShareStatus,
    setStatusCallback: (cb) => { statusCallback = cb; },
    reattach
  };
})(window);
