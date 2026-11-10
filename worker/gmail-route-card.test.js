import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseRouteCard, routeCardToKml } from "./gmail-route-card.js";

function cell(value) {
  return `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
}

function row(values) {
  return `<w:tr>${values.map(cell).join("")}</w:tr>`;
}

function docx({ title = "Route Card: TT1.35", speed = "3", bearing = "90", distance = "1 km", secondLeg = "1" } = {}) {
  const xml =
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>${title}</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Summary @ ${speed}kph</w:t></w:r></w:p>` +
    `<w:tbl>${row(["Leg", "Name / Position / Elevation", "Bearing", "Distance"])}` +
    `${row(["0", "Start SX 69475 73098 348 m", "", ""])}` +
    `${row([secondLeg, "Finish SX 70475 73098 360 m", bearing, distance])}` +
    `</w:tbl></w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

test("parses route name, speed, grid references, elevations and KML metadata", () => {
  const route = parseRouteCard(docx());
  assert.equal(route.routeName, "TT1.35");
  assert.equal(route.defaultSpeedKmh, 3);
  assert.equal(route.waypoints.length, 2);
  assert.equal(route.waypoints[0].gridReference, "SX 69475 73098");
  assert.equal(route.waypoints[0].elevationMeters, 348);
  assert.ok(Number.isFinite(route.waypoints[0].latitude));
  assert.ok(Number.isFinite(route.waypoints[0].longitude));
  assert.match(routeCardToKml(route), /<Data name="defaultSpeedKmh"><value>3<\/value><\/Data>/);
  assert.match(routeCardToKml(route), /<name>Finish<\/name>/);
});

test("rejects bearings and distances inconsistent with the route card", () => {
  assert.throws(() => parseRouteCard(docx({ bearing: "270" })), /bearing differs/);
  assert.throws(() => parseRouteCard(docx({ distance: "100 m" })), /distance exceeds/);
});

test("rejects invalid route-card metadata and waypoint numbering", () => {
  assert.throws(() => parseRouteCard(docx({ title: "Not a route card" })), /Route Card/);
  assert.throws(() => parseRouteCard(docx({ speed: "0" })), /speed is outside/);
  assert.throws(() => parseRouteCard(docx({ secondLeg: "2" })), /numbering has a gap/);
  assert.throws(() => parseRouteCard(zipSync({ "other.xml": strToU8("<root/>") })), /no usable document body/);
});
