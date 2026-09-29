import { eventIdOf, eventResponse, publicEvents } from "../event-seo.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const page = await context.env.ASSETS.fetch(new URL("/", url));
  const id = url.searchParams.get("event");
  if (!page.ok || !id || id.length > 128) return page;

  try {
    const events = await publicEvents(context);
    if (!events) return page;
    const event = events.find(item => eventIdOf(item) === id);
    return event ? eventResponse(page, event) : page;
  } catch (error) {
    console.error("QDP event preview failed:", error);
    return page;
  }
}
