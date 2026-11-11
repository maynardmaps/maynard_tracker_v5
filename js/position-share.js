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

  const POSITION_SHARE_NAME_KEY = "maynard_position_share_name";

  function init(newMap, newSettings) {
    map = newMap;
    settings = newSettings;
    if (!layerGroup) {
      layerGroup = L.featureGroup([]).addTo(map);
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

    isEnabled = true;
    sessionId = null; // Will be set on first successful share
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

    // Subscribe marker refresh to coordinator (unified with Garmin polling)
    markerRefreshSubscriptionId = MaynardPollingCoordinator.subscribe(() => {
      refreshMarkers();
    }, 10000); // Match Garmin polling interval

    // Request position immediately
    requestPositionOnce();

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
    userDisplayName = "";
    sessionId = null;

    // Unsubscribe from coordinator
    if (pollingSubscriptionId !== null) {
      MaynardPollingCoordinator.unsubscribe(pollingSubscriptionId);
      pollingSubscriptionId = null;
    }
    if (markerRefreshSubscriptionId !== null) {
      MaynardPollingCoordinator.unsubscribe(markerRefreshSubscriptionId);
      markerRefreshSubscriptionId = null;
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

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const timestamp = Date.now();
        
        lastUpdateMs = timestamp;
        sendPositionToWorker(lat, lng, timestamp);
        
        // Record success for backoff strategy
        if (gpsBackoff) {
          gpsBackoff.recordSuccess();
          updatePollingInterval(); // Adjust interval based on backoff state
        }
        
        // Record success with connection monitor
        MaynardConnectionMonitor.recordAttempt(true);
        
        if (callback) callback();
      },
      (err) => {
        console.warn("Geolocation error:", err.message);
        
        // Record failure for backoff strategy
        if (gpsBackoff) {
          gpsBackoff.recordFailure();
          updatePollingInterval(); // Adjust interval based on backoff state
        }
        
        // Record failure with connection monitor
        MaynardConnectionMonitor.recordAttempt(false);
        
        if (callback) callback();
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

  async function sendPositionToWorker(lat, lng, timestamp) {
    if (!userDisplayName) return;

    try {
      const relayUrl = (window.MAYNARD_CONFIG?.garminRelayUrl || "").replace(/\/$/, "");
      const response = await fetch(`${relayUrl}/positions/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat,
          lng,
          name: userDisplayName,
          timestamp
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      if (result.sessionId) {
        sessionId = result.sessionId;
      }
      
      // Track successful share
      lastShareSuccessMs = timestamp;
      if (statusCallback) {
        statusCallback(getLastShareStatus());
      }
    } catch (err) {
      console.error("Failed to share position:", err.message);
      if (statusCallback) {
        statusCallback({ status: "error", message: `Share failed: ${err.message}` });
      }
    }
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
        seenSessions.add(pos.sessionId);

        // Skip if expired
        const age = now - pos.timestamp;
        if (age > persistenceMs) {
          return;
        }

        // Update or create marker
        if (!markerCache.has(pos.sessionId)) {
          const marker = L.marker([pos.lat, pos.lng], {
            icon: L.divIcon({
              className: "position-share-marker",
              html: `<div class="share-marker-icon"><span class="share-marker-label">${escapeHtml(pos.name)}</span></div>`,
              iconSize: [48, 48],
              iconAnchor: [24, 48],
              popupAnchor: [0, -48]
            }),
            title: pos.name
          });

          // Build popup content
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

          const popupHtml = `
            <div class="position-share-popup">
              <strong>${escapeHtml(pos.name)}</strong>
              <div class="popup-row">Time: ${escapeHtml(timeStr)}</div>
              <div class="popup-row">Lat: ${pos.lat.toFixed(5)}</div>
              <div class="popup-row">Lng: ${pos.lng.toFixed(5)}</div>
            </div>
          `;
          marker.bindPopup(popupHtml);
          marker.addTo(layerGroup);
          markerCache.set(pos.sessionId, marker);
        } else {
          // Update existing marker
          const marker = markerCache.get(pos.sessionId);
          marker.setLatLng([pos.lat, pos.lng]);
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

  // Start polling positions from the Worker at the same interval as Garmin markers
  function setVisible(visible) {
    if (layerGroup) {
      if (visible) {
        layerGroup.addTo(map);
      } else {
        map.removeLayer(layerGroup);
      }
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
    setVisible,
    reattach
  };
})(window);
