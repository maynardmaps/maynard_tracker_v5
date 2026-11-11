// connection-monitor.js - Detects network quality and adapts polling intervals
// to match connection conditions. Tracks success/failure rates and adjusts
// polling strategies accordingly to reduce battery drain on poor connections.
(function (global) {
  "use strict";

  const WINDOW_SIZE = 20; // Track last N requests
  const FAILURE_THRESHOLD = 0.3; // 30% failure rate triggers slow mode
  const RECOVERY_THRESHOLD = 0.1; // 10% failure rate or less triggers fast mode

  let requestWindow = []; // true = success, false = failure
  let slowModeActive = false;
  let lastStatusChange = Date.now();

  function recordAttempt(success) {
    requestWindow.push(success);
    if (requestWindow.length > WINDOW_SIZE) {
      requestWindow.shift();
    }
    updateMode();
  }

  function getFailureRate() {
    if (requestWindow.length === 0) return 0;
    const failures = requestWindow.filter(s => !s).length;
    return failures / requestWindow.length;
  }

  function updateMode() {
    const failureRate = getFailureRate();
    const wasSlowMode = slowModeActive;

    // Transition to slow mode if failure rate is too high
    if (failureRate >= FAILURE_THRESHOLD) {
      slowModeActive = true;
    }
    // Transition to fast mode if failure rate is low
    else if (failureRate <= RECOVERY_THRESHOLD) {
      slowModeActive = false;
    }
    // Stay in current mode if between thresholds (hysteresis prevents flapping)

    if (slowModeActive !== wasSlowMode) {
      lastStatusChange = Date.now();
      const status = slowModeActive ? "SLOW" : "FAST";
      const rate = (failureRate * 100).toFixed(1);
      console.log(`ConnectionMonitor: switched to ${status} mode (${rate}% failure rate)`);
      MaynardUtils.diag("Network", slowModeActive ? "DEGRADED" : "OK",
        `${(failureRate * 100).toFixed(1)}% failure rate - ${slowModeActive ? "adaptive polling active" : "normal polling"}`);
    }
  }

  function isSlowMode() {
    return slowModeActive;
  }

  function getAdaptiveInterval(normalIntervalMs, slowMultiplier = 2) {
    return isSlowMode() ? normalIntervalMs * slowMultiplier : normalIntervalMs;
  }

  function getStatus() {
    return {
      slowMode: slowModeActive,
      failureRate: getFailureRate(),
      attemptCount: requestWindow.length,
      timeSinceChange: Date.now() - lastStatusChange
    };
  }

  global.MaynardConnectionMonitor = {
    recordAttempt,
    isSlowMode,
    getAdaptiveInterval,
    getStatus,
    getFailureRate
  };
})(typeof window !== "undefined" ? window : global);
