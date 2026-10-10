// weather.js - "Weather data": Met Office Weather DataHub Map Images
// precipitation overlay. The DataHub API requires an "apikey" header and has
// no CORS support, so requests go via the Cloudflare Worker relay (which holds
// the key); direct/public-proxy requests are only a low-odds fallback.
(function (global) {
  "use strict";

  let imageOverlay = null;
  let visible = false;
  let pollTimer = null;
  let lastFileId = null;

  // All requests go through the Cloudflare Worker, which holds the Met Office
  // API key and order id server-side.
  async function relayFetch(relayBase, path, binary) {
    const res = await fetch(`${relayBase}/weather/${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return binary ? res.blob() : res.json();
  }

  // fileIds look like "total_precipitation_rate_ts{N}_{+RR|yyyyMMddRR}" where
  // N is the forecast timestep in hours from the model run (runDateTime).
  // The API lists every run/timestep combination it still has, not sorted by
  // validity time, so we pick the file whose (runDateTime + N hours) is
  // closest to "now" - i.e. the image that best represents current
  // conditions rather than the furthest-out forecast.
  function pickMostCurrentFile(fileList) {
    const tsPattern = /_ts(\d+)_/;
    const now = Date.now();
    let best = null;
    let bestDiff = Infinity;
    for (const file of fileList) {
      const match = tsPattern.exec(file.fileId || "");
      if (!match || !file.runDateTime) continue;
      const tsHours = parseInt(match[1], 10);
      const validity = new Date(file.runDateTime).getTime() + tsHours * 3600000;
      const diff = Math.abs(now - validity);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = file;
      }
    }
    return best || fileList[0];
  }

  async function fetchLatestImageBlob(relayUrl) {
    const latest = await relayFetch(relayUrl, "latest", false);
    const fileList = (latest.orderDetails && latest.orderDetails.files) || latest.files || [];
    if (!fileList.length) throw new Error("No Met Office image files returned");
    const chosen = pickMostCurrentFile(fileList);
    const fileId = chosen.fileId || chosen.id;
    if (fileId === lastFileId) return null; // unchanged
    const blob = await relayFetch(relayUrl, `latest/${fileId}/data`, true);
    lastFileId = fileId;
    return blob;
  }

  async function refresh(map, { relayUrl, bounds }) {
    try {
      const blob = await fetchLatestImageBlob(relayUrl);
      if (!blob) return; // no new image
      const url = URL.createObjectURL(blob);
      const leafletBounds = [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
      ];
      const next = L.imageOverlay(url, leafletBounds, { opacity: 0.6 });
      if (visible) next.addTo(map);
      if (imageOverlay) {
        if (map.hasLayer(imageOverlay)) map.removeLayer(imageOverlay);
        URL.revokeObjectURL(imageOverlay._url);
      }
      imageOverlay = next;
    } catch (e) {
      console.warn("Met Office weather overlay refresh failed", e);
    }
  }

  function start(map, opts) {
    visible = opts.startVisible === true;
    refresh(map, opts);
    stop();
    pollTimer = setInterval(() => refresh(map, opts), opts.pollIntervalMs);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function setVisible(v, map) {
    visible = v;
    if (!imageOverlay) return;
    if (visible) imageOverlay.addTo(map);
    else if (map.hasLayer(imageOverlay)) map.removeLayer(imageOverlay);
  }

  function reattach(map) {
    if (imageOverlay && visible) imageOverlay.addTo(map);
  }

  global.MaynardWeather = { start, stop, setVisible, reattach };
})(window);
