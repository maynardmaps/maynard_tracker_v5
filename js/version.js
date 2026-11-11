// version.js - Version information for the tracker
// Updated with each commit according to semantic versioning:
// - Patch update (bug fix): increment last number (v5.1.3 → v5.1.4)
// - New feature: increment middle number, reset last to 0 (v5.1.3 → v5.2.0)
// - Major version: changed only by user request

(function (global) {
  "use strict";

  const VERSION = "5.1.4";

  global.MaynardVersion = {
    version: VERSION,
    getVersion: () => VERSION,
    getVersionString: () => `Maynard Tracker v${VERSION}`
  };
})(window);
