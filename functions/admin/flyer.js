import { verifyAccess } from "./api.js";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function imageUrl(raw) {
  if (!raw || raw.length > 3000) throw new Error("Invalid flyer URL.");
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      !/^[a-z0-9.-]+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) {
    throw new Error("Flyer must use a public HTTPS image URL.");
  }
  const driveId = url.hostname === "drive.google.com" &&
    (url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get("id"));
  return driveId
    ? new URL(`https://lh3.googleusercontent.com/d/${encodeURIComponent(driveId)}=w1600`)
    : url;
}

export async function onRequestGet(context) {
  try {
    await verifyAccess(context);
    const request = new URL(context.request.url);
    let source = imageUrl(request.searchParams.get("url"));
    let response;
    for (let redirects = 0; redirects < 4; redirects++) {
      response = await fetch(source.toString(), {
        redirect: "manual",
        headers: { Accept: "image/*" },
        cf: { cacheTtl: 0 }
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("Location");
      if (!location) throw new Error("Flyer redirect is invalid.");
      source = imageUrl(new URL(location, source).toString());
    }
    if (!response.ok || response.status >= 300) throw new Error("Flyer could not be loaded.");
    const type = (response.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) {
      throw new Error("Flyer URL did not return an image.");
    }
    if (Number(response.headers.get("Content-Length")) > MAX_IMAGE_BYTES) {
      throw new Error("Flyer is too large for image export.");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Flyer is too large for image export.");
      }
      chunks.push(value);
    }
    return new Response(new Blob(chunks, { type }), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return new Response(error.message, {
      status: /Cloudflare Access|authorized/i.test(error.message) ? 403 : 400,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" }
    });
  }
}
