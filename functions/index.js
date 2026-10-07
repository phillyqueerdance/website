import { readPreparedEvents } from "./api/events.js";
import { renderLivePoster } from "./live-poster.js";
import { resolveEvent } from "./event-records.js";
import { renderEventPage } from "./event-page.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const page = await context.env.ASSETS.fetch(new URL("/", url));
  if (!page.ok) return page;
  // Event content and metadata also apply to contextual archive URLs.
  if (url.searchParams.has("event")) {
    const id = url.searchParams.get("event") || "";
    return renderEventPage(context, page, await resolveEvent(context, id), id);
  }
  if (url.searchParams.has("archive")) return page;
  try {
    const prepared = await readPreparedEvents(context);
    if (!prepared) return page;
    const { markup, dateLabel } = renderLivePoster(prepared.events);
    const rewritten = new HTMLRewriter()
      .on("#eventStack", { element(element) { element.setInnerContent(markup, { html: true }); } })
      .on("#dateLabel", { element(element) { element.setInnerContent(dateLabel); } })
      .on("#qdpInitialEvents", { element(element) { element.setInnerContent(JSON.stringify(prepared)); } })
      .transform(page);
    const headers = new Headers(rewritten.headers);
    headers.set("Cache-Control", "public, max-age=30");
    headers.set("X-QDP-Initial-Events", "PREPARED");
    headers.delete("ETag");
    headers.delete("Content-Length");
    return new Response(rewritten.body, { headers });
  } catch (error) {
    console.error("QDP initial events unavailable:", error);
    return page;
  }
}
