import { readPreparedEvents } from "./api/events.js";
import { renderLivePoster } from "./live-poster.js";
import { resolveEvent } from "./event-records.js";
import { renderEventPage } from "./event-page.js";
import { profilePage } from "./profile-page.js";
import { directoryPage } from "./directory-page.js";
import { withKvScope, cacheResponse, freshResponse } from "./kv-cache.js";

export async function onRequestGet(context) {
  context = withKvScope(context);
  const url = new URL(context.request.url);
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cacheKey = new Request(new URL("/_qdp/prepared-home-6am-search-v1", url));
  const page = await context.env.ASSETS.fetch(new URL("/", url));
  if (!page.ok) return page;
  // Event content and metadata also apply to contextual archive URLs.
  if (url.searchParams.has("event")) {
    const id = url.searchParams.get("event") || "";
    return cacheResponse(context, renderEventPage(context, page, await resolveEvent(context, id), id), 60);
  }
  const kind = url.searchParams.get("archive");
  if (Object.hasOwn(globalThis.QDPProfileMetadata.kinds, kind || "")) {
    return profilePage(context, page, kind, url.searchParams.get("id") || "");
  }
  if (Object.hasOwn(globalThis.QDPProfileMetadata.directories, kind || "")) {
    return directoryPage(context, page, kind);
  }
  if (url.searchParams.has("archive")) return page;
  const cached = freshResponse(await cache?.match(cacheKey), context);
  if (cached) return cached;
  try {
    const prepared = await readPreparedEvents(context);
    if (!prepared) return page;
    const { markup, dateLabel } = renderLivePoster(prepared.events, new Date(Date.now()));
    const maxAge = Math.min(30, Math.max(0,
      Math.floor((globalThis.QDPLiveCalendar.nextExpiry(prepared.events) - Date.now()) / 1000)));
    const rewritten = new HTMLRewriter()
      .on("#eventStack", { element(element) { element.setInnerContent(markup, { html: true }); } })
      .on("#dateLabel", { element(element) { element.setInnerContent(dateLabel); } })
      .on("#qdpInitialEvents", { element(element) { element.setInnerContent(JSON.stringify(prepared)); } })
      .transform(page);
    const headers = new Headers(rewritten.headers);
    headers.set("Cache-Control", `public, max-age=${maxAge}`);
    headers.set("X-QDP-Initial-Events", "PREPARED");
    headers.delete("ETag");
    headers.delete("Content-Length");
    const result = cacheResponse(context, new Response(rewritten.body, { headers }), maxAge);
    if (cache) {
      const write = cache.put(cacheKey, result.clone());
      if (context.waitUntil) context.waitUntil(write); else await write;
    }
    return result;
  } catch (error) {
    console.error("QDP initial events unavailable:", error);
    return page;
  }
}
