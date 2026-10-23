import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { shareImageSvg, dataImage } from '../functions/share-image-layout.js';
import { SHARE_WIDTH } from '../functions/share-image-artifact.js';

let artwork;
async function loadArtwork() {
  const read = (name, type) => fs.readFile(new URL(`../${name}`, import.meta.url))
    .then(bytes => type ? dataImage({ bytes, type }) : bytes);
  return artwork ||= Promise.all([read('frame.png', 'image/png'),
    read('queer-popup-background.png', 'image/png'), read('melt-popup-background.jpg', 'image/jpeg')]);
}

// Native rendering runs only in GitHub Actions/local preparation, never Pages.
export async function renderShareImage(event, flyer) {
  const [frame, queer, melt] = await loadArtwork();
  const background = String(event.partyId || '').trim().toUpperCase() === 'MELT-001'
    ? melt : event.explicitQueer === true ? queer : '';
  const svg = shareImageSvg(event, { frame, background, flyer: dataImage(flyer) });
  return new Resvg(svg, { fitTo: { mode: 'width', value: SHARE_WIDTH },
    font: { fontFiles: [fileURLToPath(new URL('../Fraunces-Variable.ttf', import.meta.url))],
      loadSystemFonts: false, defaultFontFamily: 'Fraunces' } }).render().asPng();
}
