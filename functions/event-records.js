import { readPreparedEvents, onRequestGet as getLiveFeed } from "./api/events.js";
import { publicEvent } from "./api/archive.js";
import "../profile-metadata.js";

const PREFIX = "qdp-archive:v1:";
const TTL = 60;
export const validEventId = id => typeof id === "string" && /^[\w-]{1,100}$/.test(id);
export function shard(id, count) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % count;
}
const kvFor = context => context.env.QDP_ARCHIVE_KV || context.env.QDP_PUBLIC_FEED_KV;
const cacheFor = () => typeof caches === "undefined" ? null : caches.default;
const cacheKey = (context, resource, id = "") => {
  const result = new URL(`/api/${resource}`, context.request.url);
  if (id) result.searchParams.set("event", id);
  return new Request(result.href);
};
const put = (context, key, payload) => {
  const cache = cacheFor();
  if (!cache) return;
  const write = cache.put(key, Response.json(payload, { headers: { "Cache-Control": `public, max-age=${TTL}` } }));
  if (context.waitUntil) context.waitUntil(write);
  else return write;
};

export function cleanIndexedEvent(raw, manifest) {
  const event = publicEvent(raw);
  if (!event || !validEventId(event.eventId)) return null;
  event.hasVenueId = Boolean(event.venueId && manifest.venues?.includes(event.venueId));
  if (event.venueId && !event.hasVenueId) {
    event.venue = "Location not disclosed";
    event.address = "";
    event.venueId = "";
  }
  event.artistIds = event.artistIds.filter(id => manifest.artists?.includes(id));
  event.partyId = manifest.partyPublicGate === true && manifest.parties?.includes(event.partyId) ? event.partyId : "";
  event.collectiveIds = event.collectiveIds.filter(id => manifest.collectives?.includes(id));
  const lists = { artist: event.artistIds, venue: event.venueId ? [event.venueId] : [],
    party: event.partyId ? [event.partyId] : [], collective: event.collectiveIds };
  if (Array.isArray(raw.related)) event.related = raw.related.filter(item =>
    item && Object.hasOwn(lists, item.kind) && lists[item.kind].includes(item.id) && item.name)
    .map(item => ({ kind: item.kind, id: item.id, name: String(item.name).trim().slice(0, 180) }));
  return event;
}

// Compatibility for the already-published preview. A shared edge cache avoids
// rescanning old records for every event while the new publisher is installed.
export async function legacyEvents(context, manifest) {
  const key = cacheKey(context, "event-legacy-index");
  const cached = await cacheFor()?.match(key);
  if (cached) {
    const payload = await cached.json();
    if (payload.revision === manifest.revision) return payload.events;
  }
  const kv = kvFor(context);
  const records = await Promise.all(Array.from({ length: 4 }, (_, i) => kv.get(`${PREFIX}month:${i}`, "json")));
  if (records.some(record => record?.revision !== manifest.revision)) throw new Error("Archive update is propagating");
  const found = new Map();
  for (const record of records) for (const [month, entry] of Object.entries(record.entries || {})) {
    if (!manifest.months?.includes(month)) continue;
    for (const raw of entry.events || []) {
      const event = cleanIndexedEvent(raw, manifest);
      if (event) found.set(event.eventId, event);
    }
  }
  const events = [...found.values()];
  await put(context, key, { revision: manifest.revision, events });
  return events;
}

async function liveEvent(context, id) {
  let feed = await readPreparedEvents(context);
  if (!feed) {
    const response = await getLiveFeed({ ...context, request: new Request(new URL("/api/events", context.request.url)) });
    if (!response.ok) throw new Error("Live events unavailable");
    feed = await response.json();
  }
  const raw = feed.events?.find(item => item.eventId === id);
  if (!raw) return null;
  const event = publicEvent({ ...raw, public: true });
  return event ? { ...event, hasVenueId: raw.hasVenueId === true } : null;
}

export async function resolveEvent(context, id) {
  if (!validEventId(id)) return { status: 400, error: "Invalid event ID." };
  const key = cacheKey(context, "event", id);
  const cached = await cacheFor()?.match(key);
  if (cached) return cached.json();
  try {
    const kv = kvFor(context);
    const manifest = kv && await kv.get(`${PREFIX}manifest`, "json");
    if (manifest?.schema === 1 && manifest.revision) {
      if (manifest.eventIndexVersion === 1 && Array.isArray(manifest.eventIds)) {
        if (manifest.excludedEventIds?.includes(id)) return { status: 404, error: "Event unavailable." };
        if (manifest.eventIds.includes(id)) {
          const count = manifest.eventShards;
          if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("Invalid event index");
          const record = await kv.get(`${PREFIX}event:${shard(id, count)}`, "json");
          if (record?.revision !== manifest.revision) throw new Error("Event update is propagating");
          const event = cleanIndexedEvent(record.entries?.[id], manifest);
          if (!event || event.eventId !== id) return { status: 404, error: "Event unavailable." };
          const payload = { status: 200, event, indexed: true };
          await put(context, key, payload);
          return payload;
        }
        // A new upcoming event can arrive in the five-minute live feed before
        // the next archive snapshot. It remains resolvable during that interval.
        const event = await liveEvent(context, id);
        if (event) {
          const payload = { status: 200, event, indexed: false };
          await put(context, key, payload);
          return payload;
        }
        return { status: 404, error: "Event unavailable." };
      }
      const event = await liveEvent(context, id) || (await legacyEvents(context, manifest)).find(item => item.eventId === id);
      if (event) {
        const payload = { status: 200, event, indexed: false };
        await put(context, key, payload);
        return payload;
      }
      // Recently ended active-sheet events need the new index. Do not claim
      // they're absent when this older snapshot cannot establish that fact.
      return { status: 503, error: "Event data is temporarily unavailable." };
    }
    const event = await liveEvent(context, id);
    if (event) return { status: 200, event, indexed: false };
    return { status: 503, error: "Event data is temporarily unavailable." };
  } catch (error) {
    console.error("QDP event lookup unavailable:", error);
    return { status: 503, error: "Event data is temporarily unavailable." };
  }
}

async function eventsFromManifest(context, manifest) {
  if (manifest.eventIndexVersion === 1 && Array.isArray(manifest.eventIds)) {
    return manifest.eventIds.filter(id => validEventId(id) && !manifest.excludedEventIds?.includes(id))
      .map(eventId => ({ eventId }));
  }
  const events = await legacyEvents(context, manifest);
  const feed = await readPreparedEvents(context);
  const found = new Map(events.map(event => [event.eventId, event]));
  for (const event of feed?.events || []) if (validEventId(event.eventId)) found.set(event.eventId, event);
  return [...found.values()];
}

export async function publicSitemapEntries(context) {
  const kv = kvFor(context);
  const manifest = kv && await kv.get(`${PREFIX}manifest`, "json");
  if (manifest?.schema !== 1 || !manifest.revision) throw new Error("Public index unavailable");
  const meta = globalThis.QDPProfileMetadata;
  const profiles = Object.entries(meta.kinds).flatMap(([kind, directory]) => {
    if (kind === "party" && manifest.partyPublicGate !== true) return [];
    return (Array.isArray(manifest[directory]) ? manifest[directory] : [])
      .filter(meta.validId).map(id => ({ kind, id }));
  });
  return { events: await eventsFromManifest(context, manifest), profiles };
}

export async function eventSitemapEntries(context) {
  return (await publicSitemapEntries(context)).events;
}
