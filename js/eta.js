// eta.js - optional route matching and ETA calculations. Kept independent of
// Garmin ingestion and the standard route display so it can be removed cleanly.
(function (global) {
  "use strict";

  const EARTH_RADIUS_M = 6371008.8;
  const DEFAULT_SPEED_KMH = 5;
  const MAX_MATCH_DISTANCE_M = 500;
  const MAX_SPEED_KMH = 160;
  const routes = new Map();
  const histories = new Map();
  let settings = null;
  let map = null;
  let activeTeam = null;
  let highlight = null;
  let waypointHighlight = null;

  const routeId = (folder, file, index) => `${folder}/${file}#${index}`;
  const routeLabel = (folder, file, name, index) =>
    `${folder} / ${file}${name ? ` — ${name}` : ` — Route ${index + 1}`}`;

  function validDefaultSpeed(value) {
    const speed = Number(value);
    return Number.isFinite(speed) && speed >= 0.1 && speed <= MAX_SPEED_KMH ? speed : null;
  }

  function defaultSpeedFromKml(xml) {
    const data = xml.getElementsByTagNameNS("*", "Data");
    for (let i = 0; i < data.length; i++) {
      if (data[i].getAttribute("name") !== "defaultSpeedKmh") continue;
      const values = data[i].getElementsByTagNameNS("*", "value");
      if (values.length) return validDefaultSpeed(values[0].textContent);
    }
    return null;
  }

  function linesFromGeometry(geometry) {
    if (!geometry) return [];
    if (geometry.type === "LineString") return [geometry.coordinates];
    if (geometry.type === "MultiLineString") return geometry.coordinates;
    return [];
  }

  async function discoverRoutes(manifest) {
    const found = [];
    const folders = Object.keys(manifest.folders || {});
    for (const folder of folders) {
      for (const file of manifest.folders[folder] || []) {
        const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
        if (ext !== "kml" && ext !== "gpx") continue;
        try {
          const path = `routes/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
          const text = await MaynardUtils.fetchText(path, { timeoutMs: 15000 });
          const xml = new DOMParser().parseFromString(text, "text/xml");
          const fileDefaultSpeed = ext === "kml" ? defaultSpeedFromKml(xml) : null;
          const collection = ext === "gpx" ? toGeoJSON.gpx(xml) : toGeoJSON.kml(xml);
          let index = 0;
          (collection.features || []).forEach((feature) => {
            const featureIndex = index;
            if (feature.geometry && /LineString/.test(feature.geometry.type)) index += 1;
            let coordinates = linesFromGeometry(feature.geometry);
            if (coordinates.length > 1) {
              const joined = coordinates[0].slice();
              for (let i = 1; i < coordinates.length; i++) {
                if (distance(joined[joined.length - 1], coordinates[i][0]) > 5) {
                  joined.length = 0;
                  break;
                }
                joined.push(...coordinates[i].slice(1));
              }
              coordinates = joined.length ? [joined] : [];
            }
            if (!coordinates.length || coordinates[0].length < 2) return;
            const name = String((feature.properties && feature.properties.name) || "").trim();
            const routeSpeed = validDefaultSpeed(feature.properties && feature.properties.defaultSpeedKmh);
            found.push({
              id: routeId(folder, file, featureIndex),
              label: routeLabel(folder, file, name, featureIndex),
              coordinates: coordinates[0],
              defaultSpeedKmh: routeSpeed === null ? fileDefaultSpeed : routeSpeed,
              index: featureIndex
            });
          });
        } catch (error) {
          console.warn(`ETA route unavailable: ${folder}/${file}`, error);
        }
      }
    }
    return found;
  }

  function distance(a, b) {
    const toRad = (v) => v * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
  }

  function prepareRoute(definition, direction) {
    const coordinates = direction === "reverse" ? definition.coordinates.slice().reverse() : definition.coordinates;
    const cumulative = [0];
    for (let i = 1; i < coordinates.length; i++) {
      cumulative.push(cumulative[i - 1] + distance(coordinates[i - 1], coordinates[i]));
    }
    return { ...definition, coordinates, cumulative, total: cumulative[cumulative.length - 1] };
  }

  function project(point, start, end) {
    const latitude = (start[1] + end[1] + point[1]) / 3 * Math.PI / 180;
    const scaleX = EARTH_RADIUS_M * Math.cos(latitude) * Math.PI / 180;
    const scaleY = EARTH_RADIUS_M * Math.PI / 180;
    const ax = start[0] * scaleX, ay = start[1] * scaleY;
    const bx = end[0] * scaleX, by = end[1] * scaleY;
    const px = point[0] * scaleX, py = point[1] * scaleY;
    const dx = bx - ax, dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const fraction = lengthSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
    const x = ax + fraction * dx, y = ay + fraction * dy;
    return { fraction, offset: Math.hypot(px - x, py - y) };
  }

  function candidatesFor(route, point) {
    const out = [];
    for (let i = 0; i < route.coordinates.length - 1; i++) {
      const start = route.coordinates[i], end = route.coordinates[i + 1];
      const projected = project(point, start, end);
      const segmentLength = route.cumulative[i + 1] - route.cumulative[i];
      out.push({
        index: i,
        offset: projected.offset,
        progress: route.cumulative[i] + projected.fraction * segmentLength
      });
    }
    return out;
  }

  function matchPosition(route, point, timestamp, previous, accuracy) {
    const limit = Math.min(MAX_MATCH_DISTANCE_M, Math.max(100, (accuracy || 0) * 2));
    const plausible = candidatesFor(route, point).filter((c) => c.offset <= limit);
    if (!plausible.length) return { status: "off-route" };

    const elapsed = previous ? Math.max(0, timestamp - previous.time) / 1000 : 0;
    const scores = plausible.map((candidate) => {
      let score = candidate.offset;
      if (previous && elapsed > 0) {
        const travelled = Math.abs(candidate.progress - previous.progress);
        const expected = (previous.speedKmh || DEFAULT_SPEED_KMH) / 3.6 * elapsed;
        const allowance = Math.max(500, expected * 3);
        if (travelled > allowance) score += Math.min(5000, travelled - allowance);
        score += Math.min(500, Math.abs(travelled - expected) * 0.02);
      }
      return { ...candidate, score };
    }).sort((a, b) => a.score - b.score);

    if (scores.length > 1 && scores[1].score - scores[0].score < 20 &&
        Math.abs(scores[1].progress - scores[0].progress) > 500) {
      return { status: "ambiguous" };
    }
    const chosen = scores[0];
    let speedKmh = 0;
    if (previous && timestamp > previous.time) {
      speedKmh = Math.abs(chosen.progress - previous.progress) / 1000 / ((timestamp - previous.time) / 3600000);
      if (!Number.isFinite(speedKmh) || speedKmh > MAX_SPEED_KMH) return { status: "implausible" };
    }
    return { status: "matched", ...chosen, speedKmh };
  }

  function formatDuration(minutes) {
    const rounded = Math.max(0, Math.round(minutes));
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;
    return hours ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${mins}m`;
  }

  function destinationTimeZone(lat, lng) {
    if (lat >= 49 && lat <= 61 && lng >= -8 && lng <= 2) return "Europe/London";
    return null;
  }

  function localDateTimeToInstant(year, month, day, hour, minute, timeZone) {
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let instant = target;
    for (let i = 0; i < 3; i++) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date(instant));
      const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
      const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
      instant += target - represented;
    }
    return instant;
  }

  function lunchAdjustment(now, arrival, timeZone, etaSettings) {
    if (!timeZone || !etaSettings.lunchTime || !etaSettings.lunchDurationMinutes) return 0;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const lunch = etaSettings.lunchTime.split(":").map(Number);
    const hour = lunch[0], minute = lunch[1];
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return 0;
    let planned = localDateTimeToInstant(Number(values.year), Number(values.month), Number(values.day), hour, minute, timeZone);
    if (planned <= now.getTime()) {
      const tomorrow = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1));
      planned = localDateTimeToInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, timeZone);
    }
    return planned <= arrival ? etaSettings.lunchDurationMinutes : 0;
  }

  function clearHighlights() {
    if (highlight && map && map.hasLayer(highlight)) map.removeLayer(highlight);
    if (waypointHighlight && map && map.hasLayer(waypointHighlight)) map.removeLayer(waypointHighlight);
    highlight = null;
    waypointHighlight = null;
    activeTeam = null;
  }

  function highlightInfo(team, info, waypointIndex) {
    if (!map || !info || info.status !== "available") return;
    clearHighlights();
    activeTeam = team;
    const route = info.route;
    const leg = Math.max(0, Math.min(route.coordinates.length - 2, info.legIndex));
    highlight = L.polyline([route.coordinates[leg], route.coordinates[leg + 1]], {
      color: "#111", weight: 8, opacity: 0.8, interactive: false
    }).addTo(map);
    const index = Math.max(0, Math.min(route.coordinates.length - 1,
      Number.isInteger(waypointIndex) ? waypointIndex : info.nextWaypointIndex));
    waypointHighlight = L.circleMarker([route.coordinates[index][1], route.coordinates[index][0]], {
      radius: 8, color: "#111", weight: 3, fillColor: "#ffeb3b", fillOpacity: 1, interactive: false
    }).addTo(map);
  }

  function init(routeDefinitions, mapInstance, appSettings) {
    routes.clear();
    (routeDefinitions || []).forEach((definition) => routes.set(definition.id, definition));
    settings = appSettings;
    map = mapInstance;
    histories.clear();
  }

  function configuration() {
    return settings && settings.eta ? settings.eta : {};
  }

  function getInfo(team, lat, lng, timestamp, accuracy, receivedTimestamp) {
    const etaSettings = configuration();
    if (!etaSettings.enabled) return { status: "disabled" };
    const device = (settings.devices || []).find((d) => d.name === team);
    if (!device || !device.etaRouteId) return { status: "unassigned" };
    const definition = routes.get(device.etaRouteId);
    if (!definition) return { status: "unavailable", reason: "route" };
    const time = Number(timestamp);
    const receivedTime = Number(receivedTimestamp);
    const freshnessTime = Number.isFinite(receivedTime) && receivedTime > 0 ? receivedTime : time;
    if (!Number.isFinite(time) || time <= 0 ||
        !Number.isFinite(freshnessTime) || Date.now() - freshnessTime > (etaSettings.staleMinutes || 30) * 60000) {
      return { status: "unavailable", reason: "stale" };
    }
    const route = prepareRoute(definition, device.etaDirection === "reverse" ? "reverse" : "forward");
    if (!Number.isFinite(route.total) || route.total <= 0) {
      return { status: "unavailable", reason: "route" };
    }
    const historyKey = `${team}:${definition.id}:${device.etaDirection || "forward"}`;
    const history = histories.get(historyKey) || { samples: [], waypointIndex: null };
    const latest = history.samples[history.samples.length - 1];
    let lowConfidence = false;
    if (!latest || time > latest.time) {
      const match = matchPosition(route, [lng, lat], time, latest, accuracy);
      if (match.status !== "matched") {
        history.matchStatus = match.status;
        history.invalidMatches = (history.invalidMatches || 0) + 1;
        histories.set(historyKey, history);
        if (!latest || history.invalidMatches > 1) {
          return { status: "unavailable", reason: match.status, route, direction: device.etaDirection || "forward" };
        }
        lowConfidence = true;
      } else {
        history.invalidMatches = 0;
        const sample = { time, progress: match.progress, legIndex: match.index, offset: match.offset, speedKmh: match.speedKmh };
        history.samples.push(sample);
        history.samples = history.samples.filter((entry) => time - entry.time <= 60 * 60 * 1000).slice(-8);
        history.matchStatus = "matched";
        histories.set(historyKey, history);
      }
    }
    const current = history.samples[history.samples.length - 1];
    const ageMinutes = Math.max(0, (Date.now() - freshnessTime) / 60000);
    const remainingM = Math.max(0, route.total - current.progress);
    const intervalSpeeds = [];
    for (let i = 1; i < history.samples.length; i++) {
      const before = history.samples[i - 1], after = history.samples[i];
      const elapsedHours = (after.time - before.time) / 3600000;
      if (elapsedHours <= 0) continue;
      const speed = Math.abs(after.progress - before.progress) / 1000 / elapsedHours;
      if (speed > 0 && speed <= MAX_SPEED_KMH) intervalSpeeds.push(speed);
    }
    const recentSpeeds = intervalSpeeds.slice(-3).sort((a, b) => a - b);
    const middle = Math.floor(recentSpeeds.length / 2);
    const measuredSpeed = recentSpeeds.length
      ? recentSpeeds.length % 2
        ? recentSpeeds[middle]
        : (recentSpeeds[middle - 1] + recentSpeeds[middle]) / 2
      : 0;
    const fallbackSpeed = Number(device.etaFallbackSpeedKmh) || DEFAULT_SPEED_KMH;
    const speedKmh = measuredSpeed > 0 ? measuredSpeed : fallbackSpeed;
    if (ageMinutes > (etaSettings.staleMinutes || 30) || speedKmh <= 0) {
      return { status: "unavailable", reason: "stale", route, direction: device.etaDirection || "forward" };
    }
    const now = new Date();
    const etaMinutes = remainingM / 1000 / speedKmh * 60;
    const timezone = destinationTimeZone(route.coordinates[route.coordinates.length - 1][1], route.coordinates[route.coordinates.length - 1][0]);
    const baseArrival = Date.now() + etaMinutes * 60000;
    const lunchMinutes = lunchAdjustment(now, new Date(baseArrival), timezone, etaSettings);
    const arrival = new Date(baseArrival + lunchMinutes * 60000);
    const nextWaypointIndex = Math.min(route.coordinates.length - 1, current.legIndex + 1);
    const info = {
      status: "available", route, direction: device.etaDirection || "forward",
      legIndex: current.legIndex, nextWaypointIndex, remainingKm: remainingM / 1000,
      speedKmh, speedSource: measuredSpeed > 0 ? "measured" : "fallback",
      ageMinutes, lowConfidence, confidenceReason: lowConfidence ? "Recent position did not match the route" : "",
      duration: formatDuration(etaMinutes + lunchMinutes),
      arrival: timezone ? new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone, dateStyle: "medium", timeStyle: "short"
      }).format(arrival) : "Local arrival time unavailable",
      arrivalTime: timezone ? new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(arrival) : "Local time unavailable",
      lunchIncluded: lunchMinutes > 0, timezone
    };
    history.lastInfo = info;
    return info;
  }

  function headlineHtml(info) {
    if (!info || info.status !== "available") return "";
    return `<div class="eta-headline"><strong>ETA</strong> ${MaynardUtils.escapeHtml(info.arrivalTime)} · ${MaynardUtils.escapeHtml(info.duration)}</div>`;
  }

  function popupHtml(info) {
    if (!info || info.status === "disabled") return "";
    if (info.status === "unassigned") return '<section class="eta-popup"><strong>ETA</strong><div>No route assigned</div></section>';
    if (info.status !== "available") return '<section class="eta-popup"><strong>ETA</strong><div>ETA unavailable</div></section>';
    return `<section class="eta-popup"><strong>ETA</strong>` +
      `<div>${info.duration} · ${info.arrival}</div>` +
      `<div>Route: ${MaynardUtils.escapeHtml(info.route.label)} (${info.direction === "reverse" ? "back to front" : "front to back"})</div>` +
      `<div>Leg ${info.legIndex + 1} of ${info.route.coordinates.length - 1}</div>` +
      `<div>Distance remaining: ${info.remainingKm.toFixed(1)} km</div>` +
      `<div>Estimated speed: ${info.speedKmh.toFixed(1)} km/h (${info.speedSource})</div>` +
      `<div>Position age: ${Math.round(info.ageMinutes)} min${info.lunchIncluded ? " · planned lunch included" : " · planned lunch not included"}</div>` +
      (info.lowConfidence ? `<div class="eta-low-confidence">${MaynardUtils.escapeHtml(info.confidenceReason)}</div>` : "") +
      `<div class="eta-waypoint-controls"><button type="button" data-eta-waypoint="${Math.max(0, info.nextWaypointIndex - 1)}" aria-label="Previous waypoint">Previous</button>` +
      `<span data-eta-waypoint-label>Waypoint ${info.nextWaypointIndex + 1} of ${info.route.coordinates.length}</span>` +
      `<button type="button" data-eta-waypoint="${Math.min(info.route.coordinates.length - 1, info.nextWaypointIndex + 1)}" aria-label="Next waypoint">Next</button></div></section>`;
  }

  function popupOpened(team, info, popup) {
    if (!info || info.status !== "available") return;
    highlightInfo(team, info);
    const element = popup && popup.getElement();
    if (!element) return;
    element.querySelectorAll("[data-eta-waypoint]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(button.dataset.etaWaypoint);
        info.selectedWaypointIndex = index;
        const previous = element.querySelector(".eta-waypoint-controls button:first-child");
        const next = element.querySelector(".eta-waypoint-controls button:last-child");
        previous.dataset.etaWaypoint = String(Math.max(0, index - 1));
        next.dataset.etaWaypoint = String(Math.min(info.route.coordinates.length - 1, index + 1));
        element.querySelector("[data-eta-waypoint-label]").textContent =
          `Waypoint ${index + 1} of ${info.route.coordinates.length}`;
        highlightInfo(team, info, index);
      });
    });
  }

  function popupClosed(team) {
    if (activeTeam === team) clearHighlights();
  }

  function getRouteDefinitions() {
    return [...routes.values()];
  }

  function reattach(mapInstance) {
    clearHighlights();
    map = mapInstance;
  }

  global.MaynardEta = { discoverRoutes, init, reattach, getInfo, headlineHtml, popupHtml, popupOpened, popupClosed, getRouteDefinitions };
})(window);
