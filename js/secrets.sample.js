// secrets.sample.js
// ---------------------------------------------------------------------------
// Copy this file to "secrets.js" (same folder) and fill in real values.
// "secrets.js" is listed in .gitignore and must NEVER be committed to git.
//
// index.html / config.html load secrets.js *before* the app scripts, so
// window.MAYNARD_SECRETS is available everywhere as a global.
// ---------------------------------------------------------------------------
window.MAYNARD_SECRETS = {
  // Ordnance Survey Data Hub API key (Maps API - raster plan).
  osMapsApiKey: "",

  // Met Office Weather DataHub API key (Map Images product).
  metOfficeApiKey: "",

  // Met Office Map Images "order" id that contains the precipitation layer.
  metOfficePrecipitationOrderId: "",

  // GitHub Personal Access Token used ONLY by the configuration page's
  // "Save settings" button to commit settings.json back to the repo via the
  // GitHub Contents API.
  //
  // SECURITY NOTE: this token is readable by anyone who opens devtools on the
  // deployed site. Use a FINE-GRAINED token scoped to this single repository
  // with "Contents: Read and write" permission only - never a classic/broad
  // token. Treat it as something you are comfortable being public.
  githubToken: ""
};
