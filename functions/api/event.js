import { resolveEvent } from "../event-records.js";
import { withKvScope, cacheResponse } from "../kv-cache.js";

export async function onRequestGet(context) {
  context = withKvScope(context);
  const id = new URL(context.request.url).searchParams.get("event") || "";
  const result = await resolveEvent(context, id);
  return cacheResponse(context, Response.json(result.event ? { event: result.event } : { error: result.error }, {
    status: result.status,
    headers: { "Cache-Control": result.status === 200 ? "public, max-age=60" : "no-store",
      "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" }
  }), 60);
}
