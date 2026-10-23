// The popup's artwork and geometry, without its text or navigation sections.
export const SHARE_WIDTH = 900;
export const SHARE_HEIGHT = 1067;
const W = 1727, H = 2048, Q = W / 100;
const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function dataImage({ bytes, type }) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:${type};base64,${btoa(binary)}`;
}

export function shareImageSvg(event, { frame, flyer, background = '' }) {
  const x = W * .084, y = H * .0679, w = W * (1 - .084 - .0823), h = H * (1 - .0679 - .0672);
  const border = .75 * Q;
  const inner = { x: x + border, y: y + border, w: w - 2 * border, h: h - 2 * border };
  const flagSize = 9 * Q;
  const dateW = W * .4342, dateH = 5 * Q, radius = dateH;
  const dx = inner.x + (inner.w - dateW) / 2, dy = inner.y;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(event.start));
  const fontSize = 42 * Math.min(1, 35 / date.length);
  const padding = 2.7 * Q;
  const headerHeight = Math.max(dateH, event.queerArtist || event.transArtist ? flagSize : 0);
  const slot = { x: inner.x + padding, y: inner.y + headerHeight + padding,
    w: inner.w - 2 * padding, h: inner.h - headerHeight - 2 * padding };
  const stripes = (colors, left, clip) => `<g clip-path="url(#${clip})">${colors.map((color, i) =>
    `<rect x="${left}" y="${inner.y + i * flagSize / colors.length}" width="${flagSize}" height="${flagSize / colors.length + 1}" fill="${color}"/>`).join('')}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><clipPath id="interior"><rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" rx="${1.25 * Q}"/></clipPath>
      <clipPath id="pride"><path d="M${inner.x} ${inner.y}h${flagSize}L${inner.x} ${inner.y + flagSize}Z"/></clipPath>
      <clipPath id="trans"><path d="M${inner.x + inner.w - flagSize} ${inner.y}h${flagSize}v${flagSize}Z"/></clipPath></defs>
    <rect width="${W}" height="${H}" fill="#000"/>
    <image width="${W}" height="${H}" xlink:href="${escape(frame)}"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${1.7 * Q}" fill="#000"/>
    <g clip-path="url(#interior)">
      <rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="${event.explicitQueer === true ? '#290925' : '#202125'}"/>
      ${background ? `<image x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" preserveAspectRatio="none" xlink:href="${escape(background)}"/>` : ''}
      ${event.queerArtist === true ? stripes(['#e40303', '#ff8c00', '#ffed00', '#008026', '#004dff', '#750787'], inner.x, 'pride') : ''}
      ${event.transArtist === true ? stripes(['#5bcefa', '#f5a9b8', '#fff', '#f5a9b8', '#5bcefa'], inner.x + inner.w - flagSize, 'trans') : ''}
      <path d="M${dx} ${dy}h${dateW}v${dateH - radius}q0 ${radius} ${-radius} ${radius}h${-dateW + 2 * radius}q${-radius} 0 ${-radius} ${-radius}Z" fill="${event.explicitQueer === true ? '#922185' : '#fa2b5a'}"/>
      <text x="${inner.x + inner.w / 2}" y="${dy + dateH / 2 + fontSize * .35}" text-anchor="middle" font-family="Fraunces" font-weight="700" font-size="${fontSize}" fill="#ffeff2">${escape(date)}</text>
      <image x="${slot.x}" y="${slot.y}" width="${slot.w}" height="${slot.h}" preserveAspectRatio="xMidYMid meet" xlink:href="${escape(flyer)}"/>
    </g></svg>`;
}
