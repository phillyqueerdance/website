import { browser, load, setBackend, slice } from "./vendor/scene-map-face/runtime.js";

let detector;
let queue = Promise.resolve();

async function loadDetector() {
  await setBackend("cpu");
  return load({
    runtime: "tfjs", modelType: "short", maxFaces: 4,
    detectorModelUrl: new URL("./vendor/scene-map-face/model.json", import.meta.url).href
  });
}

async function detectFaces(model, data, width, height) {
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const image = browser.fromPixels({ data: pixels, width, height });
  try {
    const faces = await model.estimateFaces(image);
    if (faces.length) return faces.map(({ box }) => box);

    // A second pass can find smaller faces once they take up more of the input.
    const size = Math.max(1, Math.round(Math.min(width, height) * .75));
    const x = Math.round((width - size) / 2);
    const y = Math.round((height - size) / 2);
    const region = slice(image, [y, x, 0], [size, size, 3]);
    try {
      return (await model.estimateFaces(region)).map(({ box }) => ({
        xMin: box.xMin + x, xMax: box.xMax + x,
        yMin: box.yMin + y, yMax: box.yMax + y
      }));
    } finally {
      region.dispose();
    }
  } finally {
    image.dispose();
  }
}

self.onmessage = ({ data: { id, data, width, height } }) => {
  queue = queue.then(async () => {
    let faces = [];
    try {
      const model = await (detector ??= loadDetector());
      faces = await detectFaces(model, data, width, height);
    } catch {
      // The original aspect-ratio crop is already visible if analysis fails.
    }
    self.postMessage({ id, faces });
  });
};
