import { onRequestGet as getEventFeed, readPreparedEvents } from "./api/events.js";
import { renderLivePoster } from "./live-poster.js";

function eventTitle(event) {
  const title = String(event.title || "");
  return title
    .replace(/^(?:(?:🏳️‍🌈|🏳️‍⚧️|✊🏾)\s*)+/u, "")
    .trim() || title;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const archive = url.searchParams.has("archive");
  const [page, prepared] = await Promise.all([
    context.env.ASSETS.fetch(new URL("/", url)),
    archive ? null : readPreparedEvents(context).catch(error => {
      console.error("Prepared QDP homepage unavailable:", error);
      return null;
    })
  ]);
  if (!page.ok || archive) return page;

  const id = url.searchParams.get("event");
  if (!prepared && (!id || id.length > 128)) return page;

  try {
    let events = prepared?.events;
    if (id && !events) {
      // Keep the existing share preview when the prepared feed is unavailable.
      const feed = await getEventFeed({
        ...context,
        request: new Request(new URL("/api/events", url))
      });
      if (!feed.ok) return page;
      events = (await feed.json()).events;
    }

    let rewriter = new HTMLRewriter();
    if (prepared) {
      const { markup, dateLabel } = renderLivePoster(events);
      rewriter = rewriter
        .on("#eventStack", {
          element(element) { element.setInnerContent(markup, { html: true }); }
        })
        .on("#dateLabel", {
          element(element) { element.setInnerContent(dateLabel); }
        })
        .on("#qdpInitialEvents", {
          element(element) { element.setInnerContent(JSON.stringify(prepared)); }
        });
    }

    const event = id && id.length <= 128 && events?.find(item =>
      String(item.eventId ?? item.EventID ?? "").trim() === id
    );
    if (event) {
      const title = eventTitle(event);
      const shareTitle = `Check out ${title} on Queer Dance Philly`;
      const eventUrl = new URL("/", url);
      eventUrl.searchParams.set("event", id);
      rewriter = rewriter
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
        });
    }

    if (!prepared && !event) return page;
    const rewritten = rewriter.transform(page);

    const headers = new Headers(rewritten.headers);
    headers.set("Cache-Control", `public, max-age=${prepared ? 30 : 300}`);
    if (prepared) headers.set("X-QDP-Initial-Events", "PREPARED");
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
