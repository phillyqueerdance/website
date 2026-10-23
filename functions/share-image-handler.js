import { resolveEvent } from './event-records.js';
import { withKvScope, cacheResponse } from './kv-cache.js';
import { fetchFlyer } from './share-image-source.js';
import '../event-metadata.js';

export function shareImageHandler(render) {
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
    // Recheck publication before serving a rendered image, including cache hits.
    const key = new Request(meta.shareImage(event, url.origin));
    const cache = typeof caches === 'undefined' ? null : caches.default;
    const hit = await cache?.match(key);
    if (hit) return cacheResponse(context, hit, 60);
    try {
      const flyer = await fetchFlyer(meta.image(event));
      const png = await render(context, event, flyer);
      const image = new Response(png, { headers: { 'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex', 'Content-Disposition': 'inline' } });
      if (cache) {
        const write = cache.put(key, image.clone());
        if (context.waitUntil) context.waitUntil(write); else await write;
      }
      return cacheResponse(context, image, 60);
    } catch (error) {
      console.warn('Event share image unavailable:', error.message);
      // Preserve a working link preview if the public flyer host is unavailable.
      const fallback = await context.env.ASSETS.fetch(new URL('/qdp-share-card.jpg', url));
      return new Response(fallback.body, { headers: { 'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' } });
    }
  };
}
