// config-page.js - configuration page logic: password gate, form <-> settings
// binding, start-point picker map, map-source list editor, and saving.
(function () {
  "use strict";

  let passphrase = "";
  // The passphrase is verified and enforced by the Cloudflare Worker.

  let settings, manifest;
  let pickerMap, pickerMarker;
  let allRouteFilenames = [];

  async function main() {
    settings = await MaynardSettings.load();
    manifest = await MaynardUtils.fetchJson(window.MAYNARD_CONFIG.routesManifestUrl, { timeoutMs: 8000 });
    allRouteFilenames = Object.values(manifest.folders).flat();

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

  function populateForm() {
    // Default route folder
    const folderSelect = document.getElementById("default-route-folder");
    folderSelect.innerHTML = "";
    Object.keys(manifest.folders)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((folder) => {
        const opt = document.createElement("option");
        opt.value = folder;
        opt.textContent = folder;
        if (folder === settings.defaultRouteFolder) opt.selected = true;
        folderSelect.appendChild(opt);
      });

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
    buildRouteColourList();

    // KML marker colour
    document.getElementById("kml-marker-colour").value = settings.kmlMarkerColour || "#1565c0";

    // Weather default
    document.getElementById("weather-default").checked = settings.weatherEnabledByDefault === true;

    // Birds and rivers default
    document.getElementById("birds-rivers-default").checked = settings.birdsRiversEnabledByDefault === true;

    // Map sources
    buildMapSourceList();
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

  function buildRouteColourList() {
    const container = document.getElementById("route-colour-list");
    container.innerHTML = "";
    const colours = MaynardUtils.assignColours(allRouteFilenames, settings.routeColours || {});
    [...colours.keys()].forEach((filename) => {
      const row = document.createElement("div");
      row.className = "field-row";
      row.innerHTML =
        `<label class="field-label" for="route-colour-${cssId(filename)}">${filename}</label>` +
        `<input type="color" id="route-colour-${cssId(filename)}" value="${colours.get(filename)}" />`;
      container.appendChild(row);
    });
  }

  function cssId(str) {
    return str.replace(/[^a-z0-9]/gi, "-");
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

  function collectRouteColours() {
    const out = {};
    allRouteFilenames.forEach((filename) => {
      const el = document.getElementById(`route-colour-${cssId(filename)}`);
      if (el) out[filename] = el.value;
    });
    return out;
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
      routeColours: collectRouteColours(),
      kmlMarkerColour: document.getElementById("kml-marker-colour").value,
      weatherEnabledByDefault: document.getElementById("weather-default").checked,
      birdsRiversEnabledByDefault: document.getElementById("birds-rivers-default").checked,
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
