const crops = new Map();
const pending = new Map();
let worker;
let nextRequest = 0;

function faceWorker() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./scene-map-photo-worker.js?v=20261111-artist-map-photos-2", import.meta.url), { type: "module" });
    worker.onmessage = ({ data: { id, faces } }) => {
      pending.get(id)?.(faces);
      pending.delete(id);
    };
    worker.onerror = () => {
      worker.terminate();
      worker = null;
      for (const resolve of pending.values()) resolve([]);
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function photoFrame(width, height, faces) {
  if (!faces.length) return null;
  const xMin = Math.min(...faces.map(box => box.xMin));
  const xMax = Math.max(...faces.map(box => box.xMax));
  const yMin = Math.min(...faces.map(box => box.yMin));
  const yMax = Math.max(...faces.map(box => box.yMax));
  const focusX = (xMin + xMax) / 2;
  // Put the faces slightly above center to keep more of the people in frame.
  const focusY = (yMin + yMax) / 2 + (yMax - yMin) * .2;
  const shortSide = Math.min(width, height);

  for (const scale of [1, .9, .8]) {
    const size = shortSide * scale;
    const half = size / 2;
    const x = Math.max(0, Math.min(width - size, focusX - half));
    const y = Math.max(0, Math.min(height - size, focusY - half));
    const dx = Math.max(x + half - xMin, xMax - x - half);
    const dy = Math.max(y + half - yMin, yMax - y - half);
    if (Math.hypot(dx, dy) <= half * .95) return { x, y, size, width, height };
  }
  return null;
}

async function findCrop(src) {
  if (!faceWorker()) return null;
  const photo = new Image();
  photo.crossOrigin = "anonymous";
  photo.src = src;
  await photo.decode();
  const scale = Math.min(1, 320 / Math.max(photo.naturalWidth, photo.naturalHeight));
  const width = Math.max(1, Math.round(photo.naturalWidth * scale));
  const height = Math.max(1, Math.round(photo.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(photo, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  if (!worker) return null;
  const faces = await new Promise(resolve => {
    const id = nextRequest++;
    pending.set(id, resolve);
    try {
      worker.postMessage({ id, data, width, height }, [data.buffer]);
    } catch {
      pending.delete(id);
      resolve([]);
    }
  });
  return photoFrame(width, height, faces);
}

export async function applyArtistPhotoCrop(pattern, image, src) {
  if (!image.isConnected) return;
  if (!crops.has(src)) crops.set(src, findCrop(src).catch(() => null));
  const frame = await crops.get(src);
  if (!frame || !image.isConnected) return;
  const { x, y, size, width, height } = frame;
  pattern.setAttribute("viewBox", `${x} ${y} ${size} ${size}`);
  image.setAttribute("width", width);
  image.setAttribute("height", height);
}
