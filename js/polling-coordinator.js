// polling-coordinator.js - Unified polling coordinator that combines multiple
// data sources into a single efficient polling loop. Eliminates redundant
// position-share and kml-markers polling by merging them into one timer.
(function (global) {
  "use strict";

  let pollTimer = null;
  let subscribers = new Map(); // subscriberId -> { callback, intervalMs, lastRunMs }
  let nextSubscriberId = 0;
  let pollingIntervalMs = 10000; // Coordinator runs at fastest required interval

  function calculatePollingInterval() {
    let minInterval = Infinity;
    for (const sub of subscribers.values()) {
      if (sub.intervalMs > 0) {
        minInterval = Math.min(minInterval, sub.intervalMs);
      }
    }
    return minInterval === Infinity ? 0 : minInterval;
  }

  function restartPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    pollingIntervalMs = calculatePollingInterval();
    if (pollingIntervalMs > 0) {
      const coordinator = () => {
        const now = Date.now();
        for (const [id, sub] of subscribers.entries()) {
          if (sub.intervalMs <= 0) continue; // Paused
          if (now - (sub.lastRunMs || 0) >= sub.intervalMs) {
            try {
              sub.callback();
              sub.lastRunMs = now;
            } catch (err) {
              console.error(`Polling error in subscriber ${id}:`, err);
            }
          }
        }
      };
      pollTimer = setInterval(coordinator, Math.min(pollingIntervalMs, 1000));
      coordinator(); // Run immediately on start
    }
  }

  // Subscribe a callback to periodic polling
  // Returns a subscription ID to use with updateInterval/unsubscribe
  // callback: function to call at intervals
  // intervalMs: how often to call callback (milliseconds). Pass 0 to pause.
  function subscribe(callback, intervalMs) {
    if (typeof callback !== "function") {
      throw new Error("Callback must be a function");
    }
    if (intervalMs < 0) {
      throw new Error("Interval must be >= 0");
    }

    const id = nextSubscriberId++;
    subscribers.set(id, {
      callback,
      intervalMs: Math.max(0, intervalMs),
      lastRunMs: 0
    });

    restartPolling();
    return id;
  }

  // Update polling interval for existing subscription
  // intervalMs: new interval (0 = pause, negative values are coerced to 0)
  function updateInterval(subscriptionId, intervalMs) {
    const sub = subscribers.get(subscriptionId);
    if (!sub) {
      throw new Error(`Unknown subscription ID: ${subscriptionId}`);
    }

    sub.intervalMs = Math.max(0, intervalMs);
    restartPolling();
  }

  // Stop and remove a subscription
  function unsubscribe(subscriptionId) {
    if (subscribers.delete(subscriptionId)) {
      restartPolling();
    }
  }

  // Get count of active subscribers
  function getSubscriberCount() {
    return subscribers.size;
  }

  // Get debug info about all subscriptions
  function getStatus() {
    const subs = [];
    for (const [id, sub] of subscribers.entries()) {
      subs.push({
        id,
        intervalMs: sub.intervalMs,
        isPaused: sub.intervalMs === 0,
        timeSinceLastRun: Date.now() - (sub.lastRunMs || 0)
      });
    }
    return {
      coordinatorIntervalMs: pollingIntervalMs,
      subscriberCount: subscribers.size,
      subscriptions: subs,
      pollingActive: pollTimer !== null
    };
  }

  global.MaynardPollingCoordinator = {
    subscribe,
    updateInterval,
    unsubscribe,
    getSubscriberCount,
    getStatus
  };
})(typeof window !== "undefined" ? window : global);
