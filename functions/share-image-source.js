const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Sources come only from an approved event; this endpoint never accepts a URL.
export function publicImageUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || !/^[a-z0-9.-]+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) {
    throw new Error('Flyer must use a public HTTPS image URL.');
  }
  // Drive's public image host can return a smaller source for this export.
  if (host === 'lh3.googleusercontent.com' && /^\/d\/[\w-]+=w1600$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/=w1600$/, '=w1000');
  }
  return url;
}

export async function imageBytes(response) {
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!response.ok || !IMAGE_TYPES.has(type) || Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    throw new Error('Flyer is unavailable or is not a supported image.');
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Flyer is too large.'); }
    chunks.push(value);
  }
  if (!size) throw new Error('Image is empty.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, type };
}

export async function fetchFlyer(raw, fetcher = fetch) {
  let source = publicImageUrl(raw);
  const signal = AbortSignal.timeout(12000);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetcher(source.href, { redirect: 'manual', signal,
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return imageBytes(response);
    const location = response.headers.get('Location');
    if (!location) throw new Error('Flyer redirect is invalid.');
    source = publicImageUrl(new URL(location, source).href);
  }
  throw new Error('Too many flyer redirects.');
}
