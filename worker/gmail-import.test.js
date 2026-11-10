import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import worker from "./relay.js";

function docx() {
  const cell = (value) => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  const row = (values) => `<w:tr>${values.map(cell).join("")}</w:tr>`;
  const xml =
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>Route Card: TT1.35</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Summary @ 3kph</w:t></w:r></w:p><w:tbl>` +
    `${row(["Leg", "Name / Position / Elevation", "Bearing", "Distance"])}` +
    `${row(["0", "Start SX 69475 73098 348 m", "", ""])}` +
    `${row(["1", "Finish SX 70475 73098 360 m", "90", "1 km"])}` +
    `</w:tbl></w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

test("scheduled Gmail import commits a route, updates ETA speed, and skips retries", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const kv = new Map();
  const githubWrites = [];
  const settings = {
    defaultRouteFolder: "old-folder",
    devices: [{
      imei: "300434031477230",
      name: "TT1",
      etaRouteId: "2026-01-02/TT1.35.kml#0",
      etaFallbackSpeedKmh: 5
    }]
  };
  const attachmentData = Buffer.from(docx()).toString("base64url");
  let blobNumber = 0;

  globalThis.caches = { default: { delete: async () => true } };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "test-access-token" });
    }
    if (url.hostname === "gmail.googleapis.com") {
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "mail-1" }] });
      if (url.pathname.endsWith("/messages/mail-1")) {
        return Response.json({
          id: "mail-1",
          internalDate: String(Date.UTC(2026, 0, 2, 12)),
          payload: {
            headers: [{ name: "From", value: "Route Sender <route@example.com>" }],
            parts: [{ filename: "card.docx", body: { data: attachmentData } }]
          }
        });
      }
      throw new Error(`Unexpected Gmail URL: ${url}`);
    }
    if (url.hostname !== "api.github.com") throw new Error(`Unexpected URL: ${url}`);

    const pathname = url.pathname;
    if (init.method === "PATCH") {
      githubWrites.push({ method: "PATCH", pathname });
      return Response.json({ ref: "refs/heads/main" });
    }
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      githubWrites.push({ method: "POST", pathname, body });
      if (pathname.endsWith("/git/blobs")) return Response.json({ sha: `blob-${++blobNumber}` });
      if (pathname.endsWith("/git/trees")) return Response.json({ sha: "tree-new" });
      if (pathname.endsWith("/git/commits")) return Response.json({ sha: "commit-new" });
      throw new Error(`Unexpected GitHub POST: ${pathname}`);
    }
    if (pathname.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "head" } });
    if (pathname.endsWith("/git/commits/head")) return Response.json({ tree: { sha: "tree" } });
    if (pathname.endsWith("/git/trees/tree")) return Response.json({ tree: [] });
    if (pathname.endsWith("/contents/settings.json")) {
      return Response.json({ content: Buffer.from(JSON.stringify(settings)).toString("base64") });
    }
    throw new Error(`Unexpected GitHub GET: ${pathname}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  });

  const env = {
    GMAIL_CLIENT_ID: "client-id",
    GMAIL_CLIENT_SECRET: "client-secret",
    GMAIL_REFRESH_TOKEN: "refresh-token",
    GMAIL_ALLOWED_SENDERS: "route@example.com",
    GITHUB_TOKEN: "github-token",
    RATE_LIMIT: {
      get: async (key) => kv.get(key) || null,
      put: async (key, value) => { kv.set(key, value); },
      delete: async (key) => { kv.delete(key); }
    }
  };
  const poll = async () => {
    let task;
    await worker.scheduled({}, env, { waitUntil: (promise) => { task = promise; } });
    await task;
  };

  await poll();
  const treeWrite = githubWrites.find((write) => write.pathname.endsWith("/git/trees"));
  const committedFiles = treeWrite.body.tree.map((item) => item.path);
  assert.ok(committedFiles.includes("routes/2026-01-02/TT1.35.kml"));
  assert.ok(committedFiles.includes("settings.json"));
  const settingsBlob = githubWrites.find((write) =>
    write.pathname.endsWith("/git/blobs") && write.body.encoding === "utf-8");
  const savedSettings = JSON.parse(settingsBlob.body.content);
  assert.equal(savedSettings.defaultRouteFolder, "2026-01-02");
  assert.equal(savedSettings.devices[0].etaFallbackSpeedKmh, 3);
  assert.equal(kv.get("gmail-route-import:mail-1:0:card.docx") && JSON.parse(kv.get("gmail-route-import:mail-1:0:card.docx")).status, "imported");

  const writeCount = githubWrites.length;
  await poll();
  assert.equal(githubWrites.length, writeCount);
});
