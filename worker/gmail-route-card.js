import { unzipSync } from "fflate";
import proj4 from "proj4";

const BNG_PROJ4 = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs";
const WGS84 = "EPSG:4326";
const MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const BEARING_TOLERANCE_DEGREES = 10;
const DISTANCE_TOLERANCE_METRES = 25;

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function xmlText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function elements(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<w:${escaped}\\b[^>]*>([\\s\\S]*?)<\\/w:${escaped}>`, "g"))]
    .map((match) => match[1]);
}

function bngGridToWgs84(reference) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const first = letters.indexOf(reference[0]);
  const second = letters.indexOf(reference[1]);
  if (first < 0 || second < 0) throw new Error(`Invalid OS grid reference: ${reference}`);

  let square = null;
  for (let eastingSquare = 0; eastingSquare <= 6; eastingSquare++) {
    for (let northingSquare = 0; northingSquare <= 12; northingSquare++) {
      let firstIndex = 19 - northingSquare - ((19 - northingSquare) % 5) +
        Math.floor((eastingSquare + 10) / 5);
      let secondIndex = ((19 - northingSquare) * 5) % 25 + (eastingSquare % 5);
      if (firstIndex > 7) firstIndex += 1;
      if (secondIndex > 7) secondIndex += 1;
      if (firstIndex === first && secondIndex === second) {
        square = [eastingSquare, northingSquare];
      }
    }
  }
  if (!square) throw new Error(`OS grid square is outside the British National Grid: ${reference}`);

  const digits = reference.slice(2);
  const precision = digits.length / 2;
  const scale = 10 ** (5 - precision);
  const easting = square[0] * 100000 + Number(digits.slice(0, precision)) * scale + scale / 2;
  const northing = square[1] * 100000 + Number(digits.slice(precision)) * scale + scale / 2;
  const [longitude, latitude] = proj4(BNG_PROJ4, WGS84, [easting, northing]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < 49 || latitude > 61 || longitude < -9 || longitude > 3) {
    throw new Error(`OS grid reference is not a valid Great Britain location: ${reference}`);
  }
  return { latitude, longitude, easting, northing };
}

function haversineMeters(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const lat1 = radians(a.latitude), lat2 = radians(b.latitude);
  const deltaLat = lat2 - lat1, deltaLon = radians(b.longitude - a.longitude);
  const h = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function initialBearingDegrees(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const lat1 = radians(a.latitude), lat2 = radians(b.latitude);
  const deltaLon = radians(b.longitude - a.longitude);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function bearingDifference(a, b) {
  return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
}

function parseWaypoint(row, columns) {
  const legText = xmlText(row[columns.leg]).trim();
  if (!/^\d+$/.test(legText)) return null;

  const locationText = xmlText(row[columns.position]);
  const match = /([A-Z]{2})\s*(\d{2,5})\s+(\d{2,5})/i.exec(locationText);
  if (!match || match[2].length !== match[3].length) {
    throw new Error(`Waypoint ${legText} has no supported OS grid reference`);
  }
  const reference = `${match[1].toUpperCase()}${match[2]}${match[3]}`;
  const position = bngGridToWgs84(reference);
  const suffix = locationText.slice(match.index + match[0].length);
  const elevationMatch = /(\d{1,4})\s*m\b/i.exec(suffix);
  if (!elevationMatch) throw new Error(`Waypoint ${legText} has no elevation in metres`);

  const name = locationText.slice(0, match.index).replace(/\s+/g, " ").trim();
  if (!name) throw new Error(`Waypoint ${legText} has no name`);
  const bearingText = xmlText(row[columns.bearing]).trim();
  const distanceText = xmlText(row[columns.distance]).trim();
  let bearing = null;
  let distanceMeters = null;

  if (legText !== "0") {
    const bearingMatch = /^(\d{1,3})(?:\s*°\s*[Tt]?)?$/.exec(bearingText);
    if (!bearingMatch || Number(bearingMatch[1]) > 360) {
      throw new Error(`Waypoint ${legText} has an invalid bearing`);
    }
    bearing = Number(bearingMatch[1]);
    const distanceMatch = /^(\d+(?:\.\d+)?)\s*(km|m)$/i.exec(distanceText);
    if (!distanceMatch) throw new Error(`Waypoint ${legText} has an invalid distance`);
    distanceMeters = Number(distanceMatch[1]) * (distanceMatch[2].toLowerCase() === "km" ? 1000 : 1);
  }

  return {
    leg: Number(legText),
    name,
    gridReference: `${match[1].toUpperCase()} ${match[2]} ${match[3]}`,
    elevationMeters: Number(elevationMatch[1]),
    latitude: position.latitude,
    longitude: position.longitude,
    bearing,
    distanceMeters
  };
}

function findColumns(headerCells) {
  const labels = headerCells.map((cell) => xmlText(cell).toLowerCase().replace(/\s+/g, " ").trim());
  const find = (label) => labels.findIndex((value) => value === label);
  const columns = {
    leg: find("leg"),
    position: find("name / position / elevation"),
    bearing: find("bearing"),
    distance: find("distance")
  };
  if (Object.values(columns).some((index) => index < 0)) {
    throw new Error("The waypoint table is missing a required column");
  }
  return columns;
}

function safeRouteName(name) {
  const safe = name.trim().replace(/[^A-Za-z0-9 _().-]+/g, "-").replace(/\s+/g, " ").trim();
  if (!safe || safe.length > 76 || !/^[A-Za-z0-9]/.test(safe)) {
    throw new Error("Route Card title contains an invalid route name");
  }
  return safe;
}

export function parseRouteCard(docxBytes) {
  const files = unzipSync(docxBytes, {
    filter: (file) => file.name === "word/document.xml"
  });
  const document = files["word/document.xml"];
  if (!document || document.length > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("The Word attachment has no usable document body or is too large");
  }
  const xml = new TextDecoder().decode(document);
  const paragraphs = elements(xml, "p").map(xmlText);
  const titleLine = paragraphs.find((line) => /Route Card\s*:/i.test(line));
  const subtitleLine = paragraphs.find((line) => /Summary\s*@/i.test(line));
  const titleMatch = titleLine && /Route Card\s*:\s*(.+?)\s*$/i.exec(titleLine);
  const speedMatch = subtitleLine && /Summary\s*@\s*(\d+(?:\.\d+)?)\s*kph\b/i.exec(subtitleLine);
  if (!titleMatch) throw new Error("The Word document has no 'Route Card:' title");
  if (!speedMatch) throw new Error("The Word document has no 'Summary @ <speed>kph' subtitle");

  const routeName = safeRouteName(titleMatch[1]);
  const defaultSpeedKmh = Number(speedMatch[1]);
  if (!Number.isFinite(defaultSpeedKmh) || defaultSpeedKmh < 0.1 || defaultSpeedKmh > 160) {
    throw new Error("The route-card speed is outside the supported 0.1–160 km/h range");
  }

  const rows = elements(xml, "tr").map((row) => elements(row, "tc"));
  const header = rows.find((row) => row.some((cell) =>
    xmlText(cell).toLowerCase().includes("name / position / elevation")));
  if (!header) throw new Error("The Word document has no waypoint table");
  const columns = findColumns(header);
  const headerIndex = rows.indexOf(header);
  const waypoints = rows.slice(headerIndex + 1)
    .map((row) => parseWaypoint(row, columns))
    .filter(Boolean)
    .sort((a, b) => a.leg - b.leg);

  if (waypoints.length < 2) throw new Error("The route card must contain at least two numbered waypoints");
  waypoints.forEach((point, index) => {
    if (point.leg !== index) throw new Error(`Waypoint numbering has a gap at leg ${index}`);
    if (!index) return;
    const previous = waypoints[index - 1];
    const actualBearing = initialBearingDegrees(previous, point);
    const actualDistance = haversineMeters(previous, point);
    const bearingError = bearingDifference(actualBearing, point.bearing);
    if (bearingError > BEARING_TOLERANCE_DEGREES) {
      throw new Error(`Leg ${point.leg} bearing differs by ${bearingError.toFixed(1)}°`);
    }
    if (actualDistance > point.distanceMeters + DISTANCE_TOLERANCE_METRES) {
      throw new Error(`Leg ${point.leg} straight-line distance exceeds the listed distance by ` +
        `${(actualDistance - point.distanceMeters).toFixed(0)} m`);
    }
  });

  return { routeName, defaultSpeedKmh, waypoints };
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;"
  })[char]);
}

export function routeCardToKml(route) {
  const lineCoordinates = route.waypoints
    .map((point) => `${point.longitude},${point.latitude},${point.elevationMeters}`)
    .join(" ");
  const waypointPlacemarks = route.waypoints.map((point) =>
    `<Placemark><name>${escapeXml(point.name)}</name>` +
    `<description>Grid reference: ${escapeXml(point.gridReference)}; Elevation: ${point.elevationMeters} m</description>` +
    `<Point><coordinates>${point.longitude},${point.latitude},${point.elevationMeters}</coordinates></Point></Placemark>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<Placemark><name>${escapeXml(route.routeName)}</name><ExtendedData>` +
    `<Data name="defaultSpeedKmh"><value>${route.defaultSpeedKmh}</value></Data>` +
    `</ExtendedData><LineString><tessellate>1</tessellate><coordinates>${lineCoordinates}</coordinates></LineString></Placemark>` +
    waypointPlacemarks +
    `</Document></kml>`;
}
