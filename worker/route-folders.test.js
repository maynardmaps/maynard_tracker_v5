import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "./relay.js";

const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8"));
const request = (path, body) => new Request(`https://example.test${path}`, {
  method: "POST",
  headers: { "X-Config-Passphrase": "test", "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

test("settings accept valid folder dates and reject invalid dates and auto modes", async (t) => {
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "PUT") {
      writes.push(JSON.parse(Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8")));
      return Response.json({ ok: true });
    }
    return Response.json({ sha: "settings-sha" });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = {
    CONFIG_PASSPHRASE: "test",
    GITHUB_TOKEN: "test-token",
    RATE_LIMIT: { async get() { return null; }, async put() {} }
  };
  const save = (extra) => worker.fetch(request("/settings", { ...settings, ...extra }), env, {});
  const valid = await save({ autoRouteFolder: true, routeFolderDates: { TT1: "2024-02-29", TT2: "2026-03-29" } });
  assert.equal(valid.status, 200);
  assert.deepEqual(writes[0].routeFolderDates, { TT1: "2024-02-29", TT2: "2026-03-29" });
  assert.equal(writes[0].autoRouteFolder, true);
  for (const extra of [
    { autoRouteFolder: "true" },
    { routeFolderDates: { TT1: "2026-02-29" } },
    { routeFolderDates: { "../bad": "2026-03-29" } },
    { routeFolderDates: { TT1: "" } },
    { routeFolderDates: [] }
  ]) {
    assert.equal((await save(extra)).status, 400);
  }
});

test("folder rename and deletion update saved dates in the same commit", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let savedSettings = { ...settings, routeFolderDates: { TT1: "2026-05-01", TT2: "2026-05-02" } };
  let routeFolders = ["TT1", "TT2"];
  const changes = [];
  globalThis.caches = { default: { async delete() { return true; } } };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "head" } });
    if (url.pathname.endsWith("/git/commits/head")) return Response.json({ tree: { sha: "tree" } });
    if (url.pathname.endsWith("/git/trees/tree")) {
      return Response.json({ tree: routeFolders.map((folder) => ({ type: "blob", path: `routes/${folder}/.gitkeep`, mode: "100644", sha: `blob-${folder}` })) });
    }
    if (url.pathname.endsWith("/contents/settings.json")) {
      return Response.json({ content: Buffer.from(JSON.stringify(savedSettings)).toString("base64") });
    }
    if (url.pathname.endsWith("/git/trees") && init.method === "POST") {
      const entries = JSON.parse(init.body).tree;
      changes.push(entries);
      const updatedSettings = entries.find((entry) => entry.path === "settings.json");
      if (updatedSettings) savedSettings = JSON.parse(updatedSettings.content);
      routeFolders = routeFolders.filter((folder) => !entries.some((entry) => entry.path === `routes/${folder}/.gitkeep` && entry.sha === null));
      for (const entry of entries) {
        const match = /^routes\/([^/]+)\/\.gitkeep$/.exec(entry.path);
        if (match && entry.sha !== null && !routeFolders.includes(match[1])) routeFolders.push(match[1]);
      }
      return Response.json({ sha: "new-tree" });
    }
    if (url.pathname.endsWith("/git/commits") && init.method === "POST") return Response.json({ sha: "new-commit" });
    if (url.pathname.endsWith("/git/refs/heads/main") && init.method === "PATCH") return Response.json({ ok: true });
    throw new Error(`Unexpected GitHub request: ${init.method || "GET"} ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });
  const env = {
    CONFIG_PASSPHRASE: "test",
    GITHUB_TOKEN: "test-token",
    RATE_LIMIT: { async get() { return null; }, async put() {} }
  };
  const manage = (body) => worker.fetch(request("/routes/manage", body), env, {});
  assert.equal((await manage({ op: "renameFolder", folder: "TT1", to: "TT3" })).status, 200);
  assert.deepEqual(savedSettings.routeFolderDates, { TT2: "2026-05-02", TT3: "2026-05-01" });
  assert.ok(changes[0].some((entry) => entry.path === "routes/TT3/.gitkeep"));
  assert.ok(changes[0].some((entry) => entry.path === "settings.json"));
  assert.equal((await manage({ op: "deleteFolder", folder: "TT3" })).status, 200);
  assert.deepEqual(savedSettings.routeFolderDates, { TT2: "2026-05-02" });
  assert.ok(changes[1].some((entry) => entry.path === "routes/TT3/.gitkeep" && entry.sha === null));
  assert.ok(changes[1].some((entry) => entry.path === "settings.json"));
});
