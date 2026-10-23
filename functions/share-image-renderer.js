import { Resvg, initWasm } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import { shareImageSvg, dataImage, SHARE_WIDTH } from './share-image-layout.js';
import { imageBytes } from './share-image-source.js';

// Instantiate during Worker startup, rather than charging each image request.
const ready = initWasm(wasm);
const assets = new WeakMap();

function artwork(context, path, binary = false) {
  const owner = context.env.ASSETS;
  let cache = assets.get(owner);
  if (!cache) assets.set(owner, cache = new Map());
  if (!cache.has(path)) {
    cache.set(path, owner.fetch(new URL(path, context.request.url)).then(async response => {
      if (!response.ok) throw new Error('Share artwork is unavailable.');
      return binary ? new Uint8Array(await response.arrayBuffer()) : dataImage(await imageBytes(response));
    }).catch(error => { cache.delete(path); throw error; }));
  }
  return cache.get(path);
}

export async function renderShareImage(context, event, flyer) {
  await ready;
  const background = String(event.partyId || '').trim().toUpperCase() === 'MELT-001'
    ? '/melt-popup-background.jpg' : event.explicitQueer === true ? '/queer-popup-background.png' : '';
  const [frame, font, backdrop] = await Promise.all([
    artwork(context, '/frame.png'), artwork(context, '/Fraunces-Variable.ttf', true),
    background ? artwork(context, background).catch(() => '') : ''
  ]);
  const svg = shareImageSvg(event, { frame, background: backdrop, flyer: dataImage(flyer) });
  const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: SHARE_WIDTH },
    font: { fontBuffers: [font], defaultFontFamily: 'Fraunces' } });
  let image;
  try {
    image = renderer.render();
    return image.asPng().slice();
  } finally { image?.free(); renderer.free(); }
}
