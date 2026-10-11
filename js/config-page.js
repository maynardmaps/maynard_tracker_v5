// config-page.js - configuration page logic: password gate, form <-> settings
// binding, start-point picker map, map-source list editor, and saving.
(function () {
  "use strict";

  let passphrase = "";
  // The passphrase is verified and enforced by the Cloudflare Worker.

  let settings, manifest;
  let pickerMap, pickerMarker;

  async function main() {
    settings = await MaynardSettings.load();
    manifest = await MaynardUtils.loadRoutesManifest();

    document.getElementById("github-link").href =
      `https://github.com/${(settings.github || window.MAYNARD_CONFIG.github).owner}/` +
      `${(settings.github || window.MAYNARD_CONFIG.github).repo}`;

    document.getElementById("unlock-btn").addEventListener("click", unlock);
    document.getElementById("config-password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") unlock();
    });
    document.getElementById("save-btn").addEventListener("click", onSave);
    document.getElementById("add-map-source-btn").addEventListener("click", addMapSourceRow);

    populateForm();
    initRouteManagement();
  }

  async function unlock() {
    const entered = document.getElementById("config-password").value;
    const status = document.getElementById("password-status");
    status.textContent = "Checking...";
    status.className = "status-msg";
    try {
      await MaynardGithubSave.verifyPassphrase(entered);
      passphrase = entered;
      document.getElementById("locked-overlay").style.display = "none";
      document.getElementById("config-form").style.display = "block";
    } catch (e) {
      status.textContent = e.status === 401 ? "Incorrect passphrase." : `Could not verify (${e.message}).`;
      status.className = "status-msg error";
    }
  }

  // ---- Route management (folders and files under routes/) ----
  let rmFolder = null;
  let rmFile = null;

  const rmEl = (id) => document.getElementById(id);
  const sortNat = (arr) => arr.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  function rmStatus(msg, isError) {
    const el = rmEl("rm-status");
    el.textContent = msg;
    el.className = "status-msg" + (isError ? " error" : "");
  }

  function renderRmList(containerId, items, selected, onSelect) {
    const box = rmEl(containerId);
    box.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "rm-empty";
      empty.textContent = "(none)";
      box.appendChild(empty);
      return;
    }
    items.forEach((name) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rm-item" + (name === selected ? " selected" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(name === selected));
      btn.textContent = name;
      btn.addEventListener("click", () => onSelect(name));
      box.appendChild(btn);
    });
  }

  function renderRouteManagement() {
    const folders = sortNat(Object.keys(manifest.folders));
    if (rmFolder && !manifest.folders[rmFolder]) rmFolder = null;
    const files = rmFolder ? sortNat(manifest.folders[rmFolder]) : [];
    if (rmFile && !files.includes(rmFile)) rmFile = null;

    renderRmList("rm-folders", folders, rmFolder, (f) => { rmFolder = f; rmFile = null; renderRouteManagement(); });
    renderRmList("rm-files", files, rmFile, (f) => { rmFile = f; renderRouteManagement(); });
    rmEl("rm-folder-name").textContent = rmFolder || "(no folder selected)";
    rmEl("rm-add-folder").disabled = false;
    rmEl("rm-rename-folder").disabled = !rmFolder;
    rmEl("rm-delete-folder").disabled = !rmFolder;
    rmEl("rm-add-file").disabled = !rmFolder;
    rmEl("rm-rename-file").disabled = !rmFile;
    rmEl("rm-delete-file").disabled = !rmFile;
  }

  async function rmRun(op, successMsg) {
    rmStatus("Working...");
    document.querySelectorAll(".rm-actions button").forEach((b) => { b.disabled = true; });
    try {
      await MaynardGithubSave.manageRoutes(op, passphrase);
      manifest = await MaynardUtils.loadRoutesManifest();
      fillDefaultFolderSelect();
      rmStatus(successMsg + " Committed to GitHub; the site updates after the next Pages deploy (about a minute).");
    } catch (e) {
      rmStatus(`Failed: ${e.message}`, true);
    }
    renderRouteManagement();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.readAsDataURL(file);
    });
  }

  function initRouteManagement() {
    rmEl("rm-add-folder").addEventListener("click", () => {
      const name = (prompt("New folder name:") || "").trim();
      if (name) rmRun({ op: "addFolder", folder: name }, `Folder "${name}" added.`).then(() => { rmFolder = manifest.folders[name] ? name : rmFolder; renderRouteManagement(); });
    });
    rmEl("rm-rename-folder").addEventListener("click", () => {
      const to = (prompt(`Rename folder "${rmFolder}" to:`, rmFolder) || "").trim();
      if (!to || to === rmFolder) return;
      const from = rmFolder;
      rmRun({ op: "renameFolder", folder: from, to }, `Folder renamed to "${to}".`).then(() => {
        if (manifest.folders[to]) rmFolder = to;
        renderRouteManagement();
        if (settings.defaultRouteFolder === from) rmStatus(`Note: "${from}" was the default folder - choose a new default and Save settings.`, true);
      });
    });
    rmEl("rm-delete-folder").addEventListener("click", () => {
      const n = manifest.folders[rmFolder].length;
      if (!confirm(`Delete folder "${rmFolder}" and its ${n} file(s)? This cannot be undone from this page.`)) return;
      const from = rmFolder;
      rmFolder = null;
      rmRun({ op: "deleteFolder", folder: from }, `Folder "${from}" deleted.`).then(() => {
        if (settings.defaultRouteFolder === from) rmStatus(`Note: "${from}" was the default folder - choose a new default and Save settings.`, true);
      });
    });
    rmEl("rm-add-file").addEventListener("click", () => rmEl("rm-file-input").click());
    rmEl("rm-file-input").addEventListener("change", async (e) => {
      const folder = rmFolder;
      for (const file of Array.from(e.target.files)) {
        try {
          const contentBase64 = await fileToBase64(file);
          await rmRun({ op: "addFile", folder, name: file.name, contentBase64 }, `"${file.name}" added to ${folder}.`);
        } catch (err) {
          rmStatus(`Failed: ${err.message}`, true);
        }
      }
      e.target.value = "";
    });
    rmEl("rm-rename-file").addEventListener("click", () => {
      const to = (prompt(`Rename "${rmFile}" to (keep .gpx or .kml):`, rmFile) || "").trim();
      if (!to || to === rmFile) return;
      const name = rmFile;
      rmRun({ op: "renameFile", folder: rmFolder, name, to }, `File renamed to "${to}".`).then(() => {
        if (manifest.folders[rmFolder] && manifest.folders[rmFolder].includes(to)) rmFile = to;
        renderRouteManagement();
      });
    });
    rmEl("rm-delete-file").addEventListener("click", () => {
      if (!confirm(`Delete "${rmFile}" from "${rmFolder}"?`)) return;
      const name = rmFile;
      rmFile = null;
      rmRun({ op: "deleteFile", folder: rmFolder, name }, `"${name}" deleted.`);
    });
    renderRouteManagement();
  }
  function fillDefaultFolderSelect() {
    const folderSelect = document.getElementById("default-route-folder");
    const current = folderSelect.value || settings.defaultRouteFolder;
    folderSelect.innerHTML = "";
    Object.keys(manifest.folders)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((folder) => {
        const opt = document.createElement("option");
        opt.value = folder;
        opt.textContent = folder;
        if (folder === current) opt.selected = true;
        folderSelect.appendChild(opt);
      });
  }

  function populateForm() {
    fillDefaultFolderSelect();

    // Start point
    document.getElementById("start-lat").value = settings.startPoint.lat;
    document.getElementById("start-lng").value = settings.startPoint.lng;
    document.getElementById("start-zoom").value = settings.startZoom;
    initPickerMap();

    // GitHub integration
    const gh = settings.github || window.MAYNARD_CONFIG.github;
    document.getElementById("gh-owner").value = gh.owner;
    document.getElementById("gh-repo").value = gh.repo;
    document.getElementById("gh-branch").value = gh.branch;

    // Route colours
    buildPaletteInputs("route-colour-list", "route-colour", settings.routeColours);

    // KML marker colour
    buildPaletteInputs("marker-colour-list", "marker-colour", settings.markerColours);

    // Weather default
    document.getElementById("weather-default").checked = settings.weatherEnabledByDefault === true;

    // Birds and rivers default
    document.getElementById("birds-rivers-default").checked = settings.birdsRiversEnabledByDefault === true;

    initRiverBox();

    // Map sources
    buildMapSourceList();
  }

  const DARTMOOR_BOX = { south: 50.345, west: -4.27, north: 50.795, east: -3.57 };
  const ENGLAND_BOX = { south: 49.9, west: -6.5, north: 55.85, east: 1.8 };
  let riverMap = null;
  let riverRect = null;
  let riverCorner = null;

  function readRiverInputs() {
    const v = (id) => parseFloat(document.getElementById(id).value);
    const b = { south: v("river-south"), west: v("river-west"), north: v("river-north"), east: v("river-east") };
    return Object.values(b).every(Number.isFinite) && b.south < b.north && b.west < b.east ? b : null;
  }

  function setRiverBox(b, fit) {
    document.getElementById("river-south").value = b.south;
    document.getElementById("river-west").value = b.west;
    document.getElementById("river-north").value = b.north;
    document.getElementById("river-east").value = b.east;
    const bounds = [[b.south, b.west], [b.north, b.east]];
    if (riverRect) riverRect.setBounds(bounds);
    else riverRect = L.rectangle(bounds, { color: "#0b6bcb", weight: 2 }).addTo(riverMap);
    if (fit) riverMap.fitBounds(bounds, { padding: [10, 10] });
  }

  function collectRiverSettings() {
    return {
      enabledByDefault: document.getElementById("river-default").checked,
      bounds: readRiverInputs() || (settings.riverLevels && settings.riverLevels.bounds) || DARTMOOR_BOX
    };
  }

  function initRiverBox() {
    const cfg = settings.riverLevels || {};
    document.getElementById("river-default").checked = cfg.enabledByDefault === true;
    if (riverMap) riverMap.remove();
    riverRect = null;
    riverCorner = null;
    riverMap = L.map("pick-river-map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "\u00a9 OpenStreetMap contributors"
    }).addTo(riverMap);
    setRiverBox(cfg.bounds || DARTMOOR_BOX, true);
    riverMap.on("click", (e) => {
      if (!riverCorner) {
        riverCorner = e.latlng;
        return;
      }
      const a = riverCorner, c = e.latlng;
      riverCorner = null;
      setRiverBox({
        south: +Math.min(a.lat, c.lat).toFixed(3), north: +Math.max(a.lat, c.lat).toFixed(3),
        west: +Math.min(a.lng, c.lng).toFixed(3), east: +Math.max(a.lng, c.lng).toFixed(3)
      }, false);
    });
    ["river-north", "river-south", "river-west", "river-east"].forEach((id) =>
      document.getElementById(id).addEventListener("change", () => {
        const b = readRiverInputs();
        if (b) setRiverBox(b, false);
      })
    );
    document.getElementById("river-reset").onclick = () => setRiverBox(DARTMOOR_BOX, true);
    document.getElementById("river-england").onclick = () => setRiverBox(ENGLAND_BOX, true);
    const box = document.getElementById("pick-river-map").closest("details");
    if (box) box.addEventListener("toggle", () => riverMap.invalidateSize());
  }

  function initPickerMap() {
    if (pickerMap) pickerMap.remove();
    pickerMap = L.map("pick-start-map").setView(
      [settings.startPoint.lat, settings.startPoint.lng],
      Math.min(settings.startZoom, 15)
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "\u00a9 OpenStreetMap contributors"
    }).addTo(pickerMap);
    pickerMarker = L.marker([settings.startPoint.lat, settings.startPoint.lng], { draggable: true }).addTo(pickerMap);
    pickerMarker.on("dragend", syncLatLngInputsFromMarker);
    pickerMap.on("click", (e) => {
      pickerMarker.setLatLng(e.latlng);
      syncLatLngInputsFromMarker();
    });
    const pickerBox = document.getElementById("pick-start-map").closest("details");
    if (pickerBox) pickerBox.addEventListener("toggle", () => pickerMap.invalidateSize());
    ["start-lat", "start-lng"].forEach((id) =>
      document.getElementById(id).addEventListener("change", syncMarkerFromInputs)
    );
  }

  function syncLatLngInputsFromMarker() {
    const ll = pickerMarker.getLatLng();
    document.getElementById("start-lat").value = ll.lat.toFixed(6);
    document.getElementById("start-lng").value = ll.lng.toFixed(6);
  }

  function syncMarkerFromInputs() {
    const lat = parseFloat(document.getElementById("start-lat").value);
    const lng = parseFloat(document.getElementById("start-lng").value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      pickerMarker.setLatLng([lat, lng]);
      pickerMap.panTo([lat, lng]);
    }
  }

  function buildPaletteInputs(containerId, prefix, palette) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    MaynardUtils.sanitizePalette(palette).forEach((colour, i) => {
      const row = document.createElement("div");
      row.className = "field-row";
      row.innerHTML =
        `<label class="field-label" for="${prefix}-${i + 1}">Colour ${i + 1}</label>` +
        `<input type="color" id="${prefix}-${i + 1}" value="${colour}" />`;
      container.appendChild(row);
    });
  }

  function buildMapSourceList() {
    const container = document.getElementById("map-source-list");
    container.innerHTML = "";
    settings.mapSources.forEach((source) => container.appendChild(mapSourceRow(source)));
  }

  function mapSourceRow(source) {
    const row = document.createElement("div");
    row.className = "map-source-row";
    row.dataset.id = source.id;
    row.innerHTML =
      `<input type="checkbox" class="ms-enabled" ${source.enabled ? "checked" : ""} title="Available to map users" />` +
      `<input type="text" class="ms-name" value="${escapeAttr(source.name)}" placeholder="Display name" />` +
      `<input type="text" class="ms-url" value="${escapeAttr(source.url)}" placeholder="XYZ tile URL template, e.g. https://.../{z}/{x}/{y}.png" />` +
      `<button type="button" class="secondary ms-remove">Remove</button>`;
    row.querySelector(".ms-remove").addEventListener("click", () => row.remove());
    return row;
  }

  function addMapSourceRow() {
    const container = document.getElementById("map-source-list");
    container.appendChild(
      mapSourceRow({
        id: `custom-${Date.now()}`,
        name: "",
        url: "",
        attribution: "",
        enabled: true,
        requiresKey: false,
        type: "xyz"
      })
    );
  }

  function escapeAttr(str) {
    return String(str || "").replace(/"/g, "&quot;");
  }

  function collectPalette(prefix) {
    return MaynardUtils.DEFAULT_PALETTE.map((d, i) => {
      const el = document.getElementById(`${prefix}-${i + 1}`);
      return el ? el.value : d;
    });
  }

  function collectMapSources() {
    return [...document.querySelectorAll("#map-source-list .map-source-row")].map((row) => {
      const existing = settings.mapSources.find((s) => s.id === row.dataset.id) || {};
      return {
        id: row.dataset.id,
        name: row.querySelector(".ms-name").value.trim(),
        url: row.querySelector(".ms-url").value.trim(),
        attribution: existing.attribution || "",
        type: existing.type || "xyz",
        requiresKey: existing.requiresKey || false,
        enabled: row.querySelector(".ms-enabled").checked
      };
    });
  }

  async function onSave() {
    const statusEl = document.getElementById("save-status");
    statusEl.textContent = "Saving...";
    statusEl.className = "status-msg";

    const newSettings = {
      ...settings,
      defaultRouteFolder: document.getElementById("default-route-folder").value,
      startPoint: {
        lat: parseFloat(document.getElementById("start-lat").value),
        lng: parseFloat(document.getElementById("start-lng").value)
      },
      startZoom: parseInt(document.getElementById("start-zoom").value, 10) || settings.startZoom,
      github: {
        owner: document.getElementById("gh-owner").value.trim(),
        repo: document.getElementById("gh-repo").value.trim(),
        branch: document.getElementById("gh-branch").value.trim() || "main"
      },
      routeColours: collectPalette("route-colour"),
      markerColours: collectPalette("marker-colour"),
      weatherEnabledByDefault: document.getElementById("weather-default").checked,
      birdsRiversEnabledByDefault: document.getElementById("birds-rivers-default").checked,
      riverLevels: collectRiverSettings(),
      mapSources: collectMapSources()
    };

    const result = await MaynardSettings.save(newSettings, passphrase);
    settings = newSettings;
    if (result.githubSaved) {
      statusEl.textContent = "Saved locally and committed to GitHub.";
      statusEl.className = "status-msg ok";
    } else if (result.localSaved) {
      statusEl.textContent = `Saved locally only (${result.reason}).`;
      statusEl.className = "status-msg";
    } else {
      statusEl.textContent = "Save failed.";
      statusEl.className = "status-msg error";
    }
  }

  document.addEventListener("DOMContentLoaded", main);
})();
