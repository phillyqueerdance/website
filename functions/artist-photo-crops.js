import { archiveCacheKey, directoryCacheKey, cacheResponse, freshResponse,
  inheritCacheDeadline } from "./kv-cache.js";
import "../event-metadata.js";
import "../profile-metadata.js";

const meta = globalThis.QDPProfileMetadata;
const prefix = "qdp-artist-photo-crop:v1:";
const listSeconds = 300;
const listCacheKey = requestUrl => new Request(new URL("/_qdp/artist-photo-crops", requestUrl));
export const cropStore = env => env.QDP_ARCHIVE_KV || env.QDP_PUBLIC_FEED_KV;

async function photoKey(src) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readCrops(context, kv) {
  const cache = globalThis.caches?.default;
  const key = listCacheKey(context.request.url);
  const hit = freshResponse(await cache?.match(key), context);
  if (hit) return new Map(await hit.json());

  const records = new Map();
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const { name, metadata } of page.keys) {
      const id = name.slice(prefix.length);
      const crop = meta.photoCrop(metadata?.crop);
      if (meta.validId(id) && crop && /^[0-9a-f]{64}$/.test(metadata.photoKey)) {
        records.set(id, { crop, photoKey: metadata.photoKey });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const response = cacheResponse({}, Response.json([...records]), listSeconds);
  inheritCacheDeadline(context, response);
  if (cache) {
    const write = cache.put(key, response).catch(error => console.warn("Artist crop cache unavailable:", error));
    if (context.waitUntil) context.waitUntil(write); else await write;
  }
  return records;
}

export async function addArtistPhotoCrops(context, kv, payload) {
  if (typeof kv?.list !== "function") return;
  try {
    const records = await readCrops(context, kv);
    await Promise.all(payload.artists.map(async artist => {
      const record = records.get(artist.id);
      if (!record) return;
      const src = meta.profileImage("artist", artist)?.src;
      if (src && record.photoKey === await photoKey(src)) artist.imageCrop = record.crop;
    }));
  } catch (error) {
    console.warn("Artist photo crops unavailable:", error);
  }
}

export async function saveArtistPhotoCrop(context, kv, id, src, crop) {
  const key = prefix + id;
  if (crop) {
    // Metadata lets the directory fetch all crop settings in a single list call.
    const record = { photoKey: await photoKey(src), crop };
    await kv.put(key, JSON.stringify(record), { metadata: record });
  } else {
    await kv.delete(key);
  }
  const cache = globalThis.caches?.default;
  if (!cache) return;
  const url = context.request.url;
  await Promise.allSettled([
    cache.delete(listCacheKey(url)),
    cache.delete(archiveCacheKey(url, "artists")),
    cache.delete(directoryCacheKey(url, "artists"))
  ]);
}
