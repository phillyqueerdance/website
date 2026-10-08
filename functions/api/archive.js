// Read the prepared public archive when the preview has a KV binding. Until
// its first publish (or during propagation), keep the live Apps Script feed.
import { DEFAULT_APPS_SCRIPT_URL } from "./events.js";
import { withKvScope, readArchiveManifest, readArchiveRecord,
  cacheResponse, freshResponse } from "../kv-cache.js";

const RESOURCES = {
  artists: "archiveArtists",
  venues: "archiveVenues",
  parties: "archiveParties",
  collectives: "archiveCollectives",
  months: "archiveMonths",
  artist: "archiveArtist",
  venue: "archiveVenue",
  party: "archiveParty",
  collective: "archiveCollective",
  month: "archiveMonth"
};
const CACHE_SECONDS = 60;
const SHARDS = { artist: 4, venue: 2, party: 2, collective: 2, month: 4 };

const value = (input, limit = 500) => String(input ?? "").trim().slice(0, limit);
const publicName = input => value(input, 180).replace(/^\[(.*)\]$/s, "$1").trim();
const yes = input => input === true || /^yes$/i.test(String(input));
const RELATED_KINDS = { artist: "artists", venue: "venues", party: "parties",
  collective: "collectives" };

function safeUrl(input) {
  try {
    const url = new URL(value(input, 2048));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function profile(input, kind, publicIds = null, details = false) {
  if (!input || !yes(input.publicOk)) return null;
  const id = value(input.id, 80);
  const name = publicName(input.name);
  if (!/^[\w-]{1,80}$/.test(id) || !name) return null;
  return {
    id, name,
    count: Number.isSafeInteger(input.count) && input.count >= 0 ? input.count : null,
    bio: value(input.bio, 1200),
    website: safeUrl(input.website),
    instagram: safeUrl(input.instagram),
    ...(kind === "artists"
      ? {
          queerArtist: yes(input.queerArtist),
          transArtist: yes(input.transArtist),
          music: safeUrl(input.music)
        }
      : kind === "venues" ? {
          queerVenue: yes(input.queerVenue ?? input.queer),
          neighborhood: value(input.neighborhood, 120),
          address: value(input.address, 260),
          maps: safeUrl(input.maps)
        } : kind === "parties" ? { queerParty: yes(input.queerParty) }
          : kind === "collectives" ? { queerCollective: yes(input.queerCollective) } : {}),
    ...(details ? { related: Array.isArray(input.related) ? input.related
      .filter(item => item && Object.hasOwn(RELATED_KINDS, item.kind))
      .map(item => ({ kind: item.kind, id: value(item.id, 80), name: publicName(item.name) }))
      .filter(item => /^[\w-]{1,80}$/.test(item.id) && item.name &&
        (!publicIds || (item.kind !== "party" || publicIds.partyPublicGate === true) &&
          publicIds[RELATED_KINDS[item.kind]]?.includes(item.id)))
      .filter((item, index, all) => all.findIndex(other =>
        other.kind === item.kind && other.id === item.id) === index).slice(0, 60) : [] } : {})
  };
}

export function publicEvent(input) {
  if (!input || !yes(input.public)) return null;
  const status = value(input.status, 80);
  if (/cancel|delet|draft|private|reject/i.test(status)) return null;
  const eventId = value(input.eventId, 100);
  const start = value(input.start, 60);
  const title = value(input.title, 300);
  if (!eventId || !title || Number.isNaN(Date.parse(start))) return null;
  const description = value(input.description, 8000)
    .split(/^\s*(?:-{3,}|—+)\s*QDP (?:WEB|IDs)\s*(?:-{3,}|—+)\s*$/im)[0].trim();
  return {
    eventId, title, start,
    end: Number.isNaN(Date.parse(input.end)) ? "" : value(input.end, 60),
    description,
    venue: publicName(input.venue),
    address: value(input.address, 260),
    venueId: value(input.venueId, 80),
    artistIds: Array.isArray(input.artistIds)
      ? input.artistIds.map(id => value(id, 80)).filter(Boolean).slice(0, 40)
      : [],
    partyId: value(input.partyId, 80),
    collectiveIds: Array.isArray(input.collectiveIds)
      ? input.collectiveIds.map(id => value(id, 80)).filter(Boolean).slice(0, 40)
      : [],
    flyerUrl: safeUrl(input.flyerUrl),
    explicitQueer: yes(input.explicitQueer),
    queerArtist: yes(input.queerArtist),
    transArtist: yes(input.transArtist)
  };
}

function cleanPayload(resource, input, id, publicIds = null) {
  if (!input || typeof input !== "object") return null;
  if (["artists", "venues", "parties", "collectives"].includes(resource)) {
    if (!Array.isArray(input[resource])) return null;
    return { [resource]: input[resource].map(item => profile(item, resource)).filter(Boolean) };
  }
  if (resource === "months") {
    if (!Array.isArray(input.months)) return null;
    return { months: input.months.filter(item => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(item.month))
      .map(item => ({ month: item.month, count: Number.isSafeInteger(item.count) ? item.count : null })) };
  }
  if (!Array.isArray(input.events)) return null;
  const events = input.events.map(publicEvent).filter(Boolean);
  if (resource === "month") return { events: events.filter(event => event.start.slice(0, 7) === id) };
  const profileKind = { artist: "artists", venue: "venues", party: "parties",
    collective: "collectives" }[resource];
  const person = profile(input.profile, profileKind, publicIds, true);
  if (!person || person.id !== id) return null;
  return {
    profile: person,
    events: events.filter(event => resource === "artist" ? event.artistIds.includes(id)
      : resource === "venue" ? event.venueId === id
        : resource === "party" ? event.partyId === id : event.collectiveIds.includes(id))
  };
}

function shard(id, count) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % count;
}

async function preparedPayload(context, kv, resource, id) {
  if (!kv) return null;
  const manifest = await readArchiveManifest(context, kv);
  if (manifest?.schema !== 1 || !manifest.revision) return null;
  if (["parties", "party"].includes(resource) && manifest.partyPublicGate !== true) {
    return { unpublished: true };
  }
  if (["parties", "party", "collectives", "collective"].includes(resource) &&
      !Array.isArray(manifest[["party", "parties"].includes(resource) ? "parties" : "collectives"])) {
    return { unpublished: true };
  }

  const directory = ["artists", "venues", "parties", "collectives", "months"].includes(resource);
  if (!directory) {
    const list = manifest[{ artist: "artists", venue: "venues", party: "parties",
      collective: "collectives", month: "months" }[resource]];
    if (!Array.isArray(list)) return null;
    // A removed public profile must not be reachable by its old direct URL.
    if (!list.includes(id)) return { missing: true };
  }
  const key = directory ? resource : `${resource}:${shard(id, SHARDS[resource])}`;
  const record = await readArchiveRecord(context, kv, manifest, key);
  if (!record) return null;
  const raw = directory ? record.payload : record.entries?.[id];
  if (!raw || (!directory && !Object.hasOwn(record.entries, id))) return null;
  const payload = cleanPayload(resource, raw, id, manifest);
  return payload ? { payload } : null;
}

export async function onRequestGet(context) {
  context = withKvScope(context);
  const url = new URL(context.request.url);
  const resource = url.searchParams.get("resource") || "";
  const id = resource === "month"
    ? url.searchParams.get("month") || ""
    : url.searchParams.get("id") || "";
  if (!Object.hasOwn(RESOURCES, resource) ||
      (["artist", "venue", "party", "collective"].includes(resource) && !/^[\w-]{1,80}$/.test(id)) ||
      (resource === "month" && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(id))) {
    return Response.json({ error: "Invalid archive request." }, { status: 400 });
  }

  const headers = {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff"
  };
  const key = new URL("/api/archive", url);
  key.searchParams.set("resource", resource);
  if (id) key.searchParams.set(resource === "month" ? "month" : "id", id);
  const cacheKey = new Request(key.href);
  const cache = typeof caches === "undefined" ? null : caches.default;
  const hit = freshResponse(await cache?.match(cacheKey), context);
  if (hit) return hit;

  try {
    const prepared = await preparedPayload(context, context.env.QDP_ARCHIVE_KV || context.env.QDP_PUBLIC_FEED_KV, resource, id);
    if (prepared?.unpublished) {
      return Response.json({ error: "Directory is waiting for the sheet to be published." }, {
        status: 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
      });
    }
    if (prepared?.missing) {
      return Response.json({ error: "Public archive entry not found." }, {
        status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
      });
    }
    if (prepared?.payload) {
      const result = cacheResponse(context, Response.json(prepared.payload, {
        headers: { ...headers, "Cache-Control": "public, max-age=60",
          "X-QDP-Archive-Source": "prepared" }
      }), CACHE_SECONDS);
      if (cache) {
        const write = cache.put(cacheKey, result.clone());
        if (context.waitUntil) context.waitUntil(write); else await write;
      }
      return result;
    }
  } catch (error) {
    console.error("Prepared QDP archive unavailable; using live feed:", error);
  }

  // The Apps Script deployment may still predate the Parties approval column.
  // Wait for a prepared, gated snapshot instead of serving an ungated fallback.
  if (["parties", "party"].includes(resource)) {
    return Response.json({ error: "Directory is waiting for the sheet to be published." }, {
      status: 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
    });
  }

  try {
    const upstream = new URL(context.env.QDP_APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL);
    upstream.searchParams.set("resource", RESOURCES[resource]);
    if (id) upstream.searchParams.set(resource === "month" ? "month" : "id", id);
    const response = await fetch(upstream, { redirect: "follow", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Apps Script returned ${response.status}`);
    const payload = cleanPayload(resource, await response.json(), id);
    if (!payload) throw new Error("Apps Script archive resource is unavailable or has an invalid shape");
    const result = cacheResponse(context, Response.json(payload, { headers }), CACHE_SECONDS);
    if (cache) {
      const write = cache.put(cacheKey, result.clone());
      if (context.waitUntil) context.waitUntil(write); else await write;
    }
    return result;
  } catch (error) {
    console.error("QDP archive feed unavailable:", error);
    return Response.json({ error: "Archive feed is not connected yet." }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
    });
  }
}
