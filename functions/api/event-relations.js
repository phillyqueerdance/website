// Resolve links only when an event is opened. The initial calendar feed stays small.
import { cleanIndexedEvent, shard, validEventId } from "../event-records.js";
const PREFIX = "qdp-archive:v1:";
const KINDS = [
  { name: "artist", shards: 4 },
  { name: "venue", shards: 2 },
  { name: "party", shards: 2 },
  { name: "collective", shards: 2 }
];

function publicName(input) {
  return String(input ?? "").trim().slice(0, 180).replace(/^\[(.*)\]$/s, "$1").trim();
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const eventId = url.searchParams.get("event") || "";
  if (!validEventId(eventId)) {
    return Response.json({ error: "Invalid event ID." }, { status: 400 });
  }
  const kv = context.env.QDP_ARCHIVE_KV || context.env.QDP_PUBLIC_FEED_KV;
  if (!kv) return Response.json({ related: [] }, { headers: { "Cache-Control": "no-store" } });

  const cache = typeof caches === "undefined" ? null : caches.default;
  const normalized = new URL("/api/event-relations", url);
  normalized.searchParams.set("event", eventId);
  const cacheKey = new Request(normalized.href);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  try {
    const manifest = await kv.get(PREFIX + "manifest", "json");
    if (manifest?.schema !== 1 || !manifest.revision) throw new Error("Missing public archive");
    if (manifest.eventIndexVersion === 1 && Array.isArray(manifest.eventIds)) {
      let related = [];
      if (manifest.eventIds.includes(eventId) && !manifest.excludedEventIds?.includes(eventId)) {
        const count = manifest.eventShards;
        if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("Invalid event index");
        const record = await kv.get(`${PREFIX}event:${shard(eventId, count)}`, "json");
        if (record?.revision !== manifest.revision) throw new Error("Event update is propagating");
        related = cleanIndexedEvent(record.entries?.[eventId], manifest)?.related || [];
      }
      const response = Response.json({ related }, { headers: {
        "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff"
      } });
      if (cache) {
        const write = cache.put(cacheKey, response.clone());
        if (context.waitUntil) context.waitUntil(write); else await write;
      }
      return response;
    }
    const kinds = KINDS.filter(kind => kind.name !== "party" || manifest.partyPublicGate === true);
    const keys = kinds.flatMap(kind => Array.from({ length: kind.shards }, (_, index) => ({
      kind: kind.name, key: `${PREFIX}${kind.name}:${index}`
    })));
    const records = await Promise.all(keys.map(async item => ({
      kind: item.kind, data: await kv.get(item.key, "json")
    })));
    if (records.some(item => item.data?.revision !== manifest.revision)) {
      throw new Error("Archive update is propagating");
    }
    const seen = new Set();
    const related = [];
    for (const { kind, data } of records) {
      for (const entry of Object.values(data.entries || {})) {
        const person = entry?.profile;
        if (person?.publicOk !== true || !/^[\w-]{1,80}$/.test(String(person.id || "")) ||
            !Array.isArray(entry.events) ||
            !entry.events.some(event => event?.public === true && event.eventId === eventId)) continue;
        const name = publicName(person.name);
        const key = `${kind}:${person.id}`;
        if (!name || seen.has(key)) continue;
        seen.add(key);
        related.push({ kind, id: person.id, name });
      }
    }
    const kindOrder = new Map(KINDS.map((kind, index) => [kind.name, index]));
    related.sort((a, b) => kindOrder.get(a.kind) - kindOrder.get(b.kind) ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const response = Response.json({ related }, { headers: {
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff"
    } });
    if (cache) {
      const write = cache.put(cacheKey, response.clone());
      if (context.waitUntil) context.waitUntil(write); else await write;
    }
    return response;
  } catch (error) {
    console.error("QDP related links unavailable:", error);
    return Response.json({ error: "Related links temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
    });
  }
}
