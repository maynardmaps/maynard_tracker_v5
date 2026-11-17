// Dartmoor terrain data is only loaded when ETA is enabled.
(function (global) {
  "use strict";

  const WIDTH = 2340;
  const HEIGHT = 2340;
  const WEST = 225000;
  const NORTH = 105200;
  const CELL_M = 30;
  let pixels = null;

  async function load() {
    if (pixels) return;
    const image = new Image();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
        reject(new Error("Timed out loading Dartmoor terrain data"));
      }, 15000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("Could not load Dartmoor terrain data")); };
      image.src = "data/dartmoor-terrain-30m.png";
    });
    if (image.naturalWidth !== WIDTH || image.naturalHeight !== HEIGHT) {
      throw new Error("Dartmoor terrain data has unexpected dimensions");
    }
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create terrain data canvas");
    context.drawImage(image, 0, 0);
    pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
  }

  function sample(lng, lat) {
    if (!pixels) return null;
    const [east, north] = global.proj4("EPSG:4326", global.MaynardUtils.BNG_PROJ4, [lng, lat]);
    const x = (east - WEST) / CELL_M - 0.5;
    const y = (NORTH - north) / CELL_M - 0.5;
    const col = Math.floor(x), row = Math.floor(y);
    if (col < 0 || row < 0 || col + 1 >= WIDTH || row + 1 >= HEIGHT) return null;
    function height(c, r) {
      const offset = (r * WIDTH + c) * 4;
      const encoded = pixels[offset] * 256 + pixels[offset + 1];
      return encoded === 65535 ? null : (encoded - 10000) / 10;
    }
    const a = height(col, row), b = height(col + 1, row);
    const c = height(col, row + 1), d = height(col + 1, row + 1);
    if ([a, b, c, d].some((value) => value === null)) return null;
    const fx = x - col, fy = y - row;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  global.MaynardEtaTerrain = { load, sample, isReady: () => pixels !== null };
})(window);
