import { onRequestGet as getEventFeed } from "./api/events.js";

function eventTitle(event) {
  const title = String(event.title || "");
  return title
    .replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/u, "")
    .trim() || title;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const page = await context.env.ASSETS.fetch(new URL("/", url));
  const id = url.searchParams.get("event");
  if (!page.ok || !id || id.length > 128) return page;

  try {
    // Reuse the public event feed and its cache, including its publication gate.
    const feedRequest = new Request(new URL("/api/events", url));
    const feed = await getEventFeed({
      request: feedRequest,
      waitUntil: task => context.waitUntil(task)
    });
    if (!feed.ok) return page;

    const { events } = await feed.json();
    if (!Array.isArray(events)) return page;
    const event = events.find(item =>
      String(item.eventId ?? item.EventID ?? "").trim() === id
    );
    if (!event) return page;

    const title = eventTitle(event);
    if (!title) return page;
    const shareTitle = `Check out ${title} on Queer Dance Philly`;
    const eventUrl = new URL("/", url);
    eventUrl.searchParams.set("event", id);

    const rewritten = new HTMLRewriter()
      .on("title", {
        element(element) { element.setInnerContent(shareTitle); }
      })
      .on('meta[property="og:title"]', {
        element(element) { element.setAttribute("content", shareTitle); }
      })
      .on('meta[name="twitter:title"]', {
        element(element) { element.setAttribute("content", shareTitle); }
      })
      .on('meta[property="og:url"]', {
        element(element) { element.setAttribute("content", eventUrl.toString()); }
      })
      .on('link[rel="canonical"]', {
        element(element) { element.setAttribute("href", eventUrl.toString()); }
      })
      .transform(page);

    const headers = new Headers(rewritten.headers);
    headers.set("Cache-Control", "public, max-age=300");
    headers.delete("ETag");
    headers.delete("Content-Length");
    return new Response(rewritten.body, {
      status: rewritten.status,
      statusText: rewritten.statusText,
      headers
    });
  } catch (error) {
    console.error("QDP event preview failed:", error);
    return page;
  }
}
