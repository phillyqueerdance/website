// Resolve links only when an event is opened. The initial calendar feed stays small.
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
  if (!eventId || eventId.length > 128 || /[\r\n]/.test(eventId)) {
    return Response.json({ error: "Invalid event ID." }, { status: 400 });
  }
  const kv = context.env.QDP_ARCHIVE_KV;
  if (!kv) return Response.json({ related: [] }, { headers: { "Cache-Control": "no-store" } });

  const cache = caches.default;
  const cacheKey = new Request(url.href);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const manifest = await kv.get(PREFIX + "manifest", "json");
    if (manifest?.schema !== 1 || !manifest.revision) throw new Error("Missing public archive");
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
    context.waitUntil?.(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error("QDP related links unavailable:", error);
    return Response.json({ related: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
