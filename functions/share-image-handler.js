import { resolveEvent } from './event-records.js';
import { withKvScope, cacheResponse } from './kv-cache.js';
import { shareArtifact } from './share-image-artifact.js';
import '../event-metadata.js';

export function shareImageHandler(fetcher = fetch) {
  return async context => {
    context = withKvScope(context);
    const url = new URL(context.request.url);
    const id = url.searchParams.get('event') || '';
    const result = await resolveEvent(context, id);
    if (!result.event) return new Response(result.error, { status: result.status,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    const event = result.event, meta = globalThis.QDPEventMetadata;
    if (!meta.image(event)) return new Response('No public flyer.', { status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    // Recheck publication before serving any image, including cache hits.
    const key = new Request(meta.shareImage(event, url.origin));
    const cache = typeof caches === 'undefined' ? null : caches.default;
    const hit = await cache?.match(key);
    if (hit) return cacheResponse(context, hit, 60);
    try {
      const artifact = await shareArtifact(event);
      const saved = await fetcher(artifact.url, { redirect: 'follow',
        signal: AbortSignal.timeout(5000), headers: { Accept: 'image/png', 'User-Agent': 'QDP-Share-Images' } });
      if (!saved.ok || !['image/png', 'application/octet-stream'].includes(
        (saved.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase()) ||
        Number(saved.headers.get('Content-Length')) > 4 * 1024 * 1024) {
        await saved.body?.cancel();
        throw new Error('Image has not been prepared.');
      }
      const reader = saved.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Invalid prepared image.'); }
        chunks.push(value);
      }
      const png = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.byteLength; }
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => png[i] === byte)) {
        throw new Error('Invalid prepared image.');
      }
      const image = new Response(png, { headers: { 'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex', 'Content-Disposition': 'inline', 'X-QDP-Share-Image': 'prepared' } });
      if (cache) {
        const write = cache.put(key, image.clone());
        if (context.waitUntil) context.waitUntil(write); else await write;
      }
      return cacheResponse(context, image, 60);
    } catch (error) {
      // Preparation is never attempted here. New or temporarily unavailable
      // images use the original public flyer until the next background refresh.
      return new Response(null, { status: 302, headers: { Location: meta.image(event),
        'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex', 'X-QDP-Share-Image': 'pending' } });
    }
  };
}
