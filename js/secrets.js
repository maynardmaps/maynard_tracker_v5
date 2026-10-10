// secrets.js - browser-visible settings only. This file IS committed and is
// readable by anyone who views the site, so it must hold nothing sensitive.
//
// The OS Maps key is meant for browsers: restrict it by HTTP referrer to
// https://maynardmaps.github.io/* in the OS Data Hub project.
// The Met Office key/order id and the GitHub token live only as Cloudflare
// Worker secrets/vars (see worker/ and README.md).
window.MAYNARD_SECRETS = {
  osMapsApiKey: "45zdy0NMpo7ajZXUyoNTyWHlGn7L0kKH"
};
