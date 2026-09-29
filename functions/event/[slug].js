import { eventResponse, eventSlug, publicEvents } from "../../event-seo.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const rawSlug = url.pathname.slice("/event/".length);
  if (!rawSlug || rawSlug.includes("/")) return new Response(null, { status: 404 });

  try {
    const slug = decodeURIComponent(rawSlug);
    const events = await publicEvents(context);
    if (!events) return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    const event = events.find(item => eventSlug(item) === slug);
    if (!event) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

    const page = await context.env.ASSETS.fetch(new URL("/", url));
    return page.ok ? eventResponse(page, event) : page;
  } catch (error) {
    console.error("QDP event page failed:", error);
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
