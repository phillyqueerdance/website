import { publicSitemapEntries } from "./event-records.js";
import { withKvScope, cacheResponse, freshResponse } from "./kv-cache.js";
import "../event-metadata.js";

export async function onRequestGet(context) {
  context = withKvScope(context);
  const meta = globalThis.QDPEventMetadata;
  const origin = context.env.QDP_CANONICAL_ORIGIN || meta.origin;
  const key = new Request(new URL("/sitemap.xml", context.request.url));
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = freshResponse(await cache?.match(key), context);
  if (cached) return cached;
  try {
    const { events, profiles } = await publicSitemapEntries(context);
    const escape = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const urls = [new URL("/", origin).href, ...events.map(event => meta.url(event.eventId, origin)),
      ...profiles.map(({ kind, id }) => globalThis.QDPProfileMetadata.url(kind, id, origin))];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      [...new Set(urls)].map(url => `<url><loc>${escape(url)}</loc></url>`).join("") + '</urlset>';
    const response = cacheResponse(context, new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } }), 60);
    if (cache) {
      const write = cache.put(key, response.clone());
      if (context.waitUntil) context.waitUntil(write); else await write;
    }
    return response;
  } catch (error) {
    console.error("QDP sitemap unavailable:", error);
    return new Response("Sitemap temporarily unavailable.", { status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
