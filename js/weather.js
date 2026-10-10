// weather.js - "Weather data": Met Office Weather DataHub Map Images
// precipitation overlay. The DataHub API requires an "apikey" header and has
// no CORS support, so requests go via the Cloudflare Worker relay (which holds
// the key); direct/public-proxy requests are only a low-odds fallback.
(function (global) {
  "use strict";

  const API_BASE = "https://data.hub.api.metoffice.gov.uk/map-images/1.0.0";

  let imageOverlay = null;
  let visible = false;
  let pollTimer = null;
  let lastFileId = null;

  // Preferred route: the Cloudflare Worker relay, which holds the API key
  // server-side. relayPath is e.g. "orders/<id>/latest[/<fileId>/data]".
  // Falls back to direct/public-proxy requests with the key in the browser.
  async function fetchWithApiKeyViaProxies(url, apikey, proxies, binary, relayBase, relayPath) {
    let lastErr;
    if (relayBase && relayPath) {
      try {
        const res = await fetch(`${relayBase}/weather/${relayPath}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return binary ? await res.blob() : await res.json();
      } catch (e) {
        lastErr = e;
        console.warn("Weather relay failed, trying fallbacks", e);
      }
    }
    if (!apikey) throw lastErr || new Error("No Met Office API key configured");
    // Try a direct request in case the API ever allows CORS.
    try {
      const res = await fetch(url, { headers: { apikey } });
      if (res.ok) return binary ? res.blob() : res.json();
    } catch (e) {
      lastErr = e;
    }
    for (const proxyPrefix of proxies) {
      try {
        const proxied = proxyPrefix + encodeURIComponent(url);
        const res = await fetch(proxied, { headers: { apikey } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return binary ? await res.blob() : await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("All request attempts failed");
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

  async function fetchLatestImageBlob(orderId, apikey, proxies, relayUrl) {
    const latest = await fetchWithApiKeyViaProxies(
      `${API_BASE}/orders/${orderId}/latest`,
      apikey,
      proxies,
      false,
      relayUrl,
      `${orderId}/latest`
    );
    const fileList = (latest.orderDetails && latest.orderDetails.files) || latest.files || [];
    if (!fileList.length) throw new Error("No Met Office image files returned");
    const chosen = pickMostCurrentFile(fileList);
    const fileId = chosen.fileId || chosen.id;
    if (fileId === lastFileId) return null; // unchanged
    const blob = await fetchWithApiKeyViaProxies(
      `${API_BASE}/orders/${orderId}/latest/${encodeURIComponent(fileId)}/data`,
      apikey,
      proxies,
      true,
      relayUrl,
      `${orderId}/latest/${fileId}/data`
    );
    lastFileId = fileId;
    return blob;
  }

  async function refresh(map, { orderId, apikey, proxies, relayUrl, bounds }) {
    try {
      const blob = await fetchLatestImageBlob(orderId, apikey, proxies, relayUrl);
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
