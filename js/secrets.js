// secrets.js - browser-visible settings only. This file IS committed and is
// readable by anyone who views the site, so it must hold nothing sensitive.
//
// All API keys (OS Maps, Met Office) and the GitHub token live only as
// Cloudflare Worker secrets (see worker/ and README.md).
window.MAYNARD_SECRETS = {};
