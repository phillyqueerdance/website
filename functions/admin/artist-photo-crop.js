import { verifyAccess } from "./api.js";
import { onRequestGet as archiveData } from "../api/archive.js";
import { cropStore, saveArtistPhotoCrop } from "../artist-photo-crops.js";
import { archiveCacheKey } from "../kv-cache.js";

const meta = globalThis.QDPProfileMetadata;
const json = (body, status = 200) => Response.json(body, {
  status, headers: {
    "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff"
  }
});

export async function onRequestPost(context) {
  const { request, env } = context;
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  try {
    await verifyAccess(context);
  } catch {
    return json({ error: "Sign in to QDP Admin to save a crop." }, 403);
  }

  let body;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
      return json({ error: "Expected a JSON crop." }, 415);
    }
    if (Number(request.headers.get("Content-Length")) > 8192) {
      return json({ error: "Crop request is too large." }, 413);
    }
    const text = await request.text();
    if (text.length > 8192) return json({ error: "Crop request is too large." }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid crop request." }, 400);
  }
  const { id, src, crop: value } = body || {};
  const crop = meta.photoCrop(value);
  if (!meta.validId(id) || typeof src !== "string" || !src || (value !== null && !crop)) {
    return json({ error: "Choose an artist and a valid crop." }, 400);
  }
  const kv = cropStore(env);
  if (typeof kv?.put !== "function" || typeof kv?.delete !== "function" || typeof kv?.list !== "function") {
    return json({ error: "Crop storage is unavailable on this deployment." }, 503);
  }

  try {
    const response = await archiveData({ ...context, request: archiveCacheKey(request.url, "artists") });
    if (!response.ok) return json({ error: "Could not verify the artist photo. Try again." }, 503);
    const { artists } = await response.json();
    const artist = artists.find(item => item.id === id);
    if (!artist || meta.profileImage("artist", artist)?.src !== src) {
      return json({ error: "This artist’s published photo has changed. Reload the editor and try again." }, 409);
    }
    await saveArtistPhotoCrop(context, kv, id, src, crop);
    return json({ crop });
  } catch (error) {
    console.error("Artist crop save failed:", error);
    return json({ error: "Could not save the crop. Try again." }, 503);
  }
}
