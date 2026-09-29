import { canonicalEventUrl, eventSlug, publicEvents } from "../event-seo.js";

export async function onRequestGet(context) {
  try {
    const events = await publicEvents(context);
    if (!events) throw new Error("The public event feed is unavailable.");
    const urls = ["https://queerdancephilly.com/"];
    const seen = new Set();
    for (const event of events) {
      const slug = eventSlug(event);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      urls.push(canonicalEventUrl(event));
    }
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map(url => `  <url><loc>${url.replace(/&/g, "&amp;")}</loc></url>`).join("\n") +
      '\n</urlset>\n';
    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    console.error("QDP sitemap failed:", error);
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
