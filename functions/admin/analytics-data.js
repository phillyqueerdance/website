import { verifyAccess } from "./api.js";
import { configured, dateRange, readAnalytics, readEventBreakdown, validEntityId, smallJson, json } from "../qdp-analytics.js";

export async function onRequestGet(context) {
  try { await verifyAccess(context); } catch { return json({ error: "Sign in to QDP Admin again." }, 403); }
  let range;
  try { range = dateRange(new URL(context.request.url)); }
  catch (error) { return json({ error: error.message }, 400); }
  const eventId = new URL(context.request.url).searchParams.get("event") || "";
  if (eventId && !validEntityId(eventId)) return json({ error: "Invalid event ID." }, 400);
  const cache = typeof caches === "undefined" ? null : caches.default;
  // Keep the cache key under the same Access-protected path as the API.
  const key = new Request(new URL(`/admin/analytics-data?cache=v1&from=${range.start}&to=${range.end}&event=${eventId}`, context.request.url));
  const cached = await cache?.match(key);
  if (cached && !new URL(context.request.url).searchParams.has("refresh")) {
    return json(await cached.json());
  }
  try {
    const payload = eventId ? await readEventBreakdown(context.env, range, eventId) : await readAnalytics(context.env, range);
    if (payload.configured && cache) context.waitUntil(cache.put(key, json(payload, 200, "public, max-age=300")));
    return json(payload);
  } catch {
    return json({ error: "Analytics could not load. The database may need setup, or a free limit may have been reached. Event editing is available separately." }, 503);
  }
}

export async function onRequestPost(context) {
  if (context.request.headers.get("Origin") !== new URL(context.request.url).origin) return json({ error: "Same-origin requests only." }, 403);
  try { await verifyAccess(context); } catch { return json({ error: "Sign in to QDP Admin again." }, 403); }
  if (!configured(context.env)) return json({ error: "Finish analytics setup first." }, 503);
  let body;
  try { body = await smallJson(context.request); } catch { return json({ error: "Invalid request." }, 400); }
  if (typeof body.enabled !== "boolean") return json({ error: "Choose whether collection is enabled." }, 400);
  try {
    const db = context.env.QDP_ANALYTICS, now = new Date().toISOString();
    await db.batch([
      body.enabled ? db.prepare("UPDATE qdp_analytics_gaps SET ended_at = ? WHERE ended_at IS NULL").bind(now) :
        db.prepare(`INSERT OR IGNORE INTO qdp_analytics_gaps (started_at)
          SELECT ? WHERE EXISTS (SELECT 1 FROM qdp_analytics_settings WHERE id = 1 AND enabled = 1)`).bind(now),
      db.prepare("UPDATE qdp_analytics_settings SET enabled = ? WHERE id = 1").bind(Number(body.enabled))
    ]);
    return json({ ok: true, enabled: body.enabled });
  } catch { return json({ error: "Collection settings could not be saved." }, 503); }
}
