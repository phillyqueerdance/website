import { verifyAccess } from "./api.js";
import { readDiscoveryDecision, saveDiscoveryDecision } from "../discovery-decisions.js";
import { validateIdentity } from "../../shared/discovery-identity.js";

const json = (data, status = 200) => Response.json(data, { status, headers: {
  "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff"
} });

export async function onRequestPost(context) {
  const { request, env } = context;
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  try { await verifyAccess(context); }
  catch { return json({ error: "Sign in to QDP Admin to save decisions." }, 403); }
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) {
      return json({ error: "Expected JSON decisions." }, 415);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 128 * 1024) return json({ error: "Decision request is too large." }, 413);
    const body = JSON.parse(raw);
    if (!["read", "save"].includes(body.operation) || !Array.isArray(body.items) || body.items.length > 5) {
      return json({ error: "Save up to five event decisions per request." }, 400);
    }
    // Validate the full batch before writing any decisions.
    for (const item of body.items) {
      validateIdentity(item.identity);
      if (body.operation === "save" && !["WAIT", "EXCLUDE"].includes(item.decision)) {
        return json({ error: "Choose Wait or Exclude. Include needs a confirmed import." }, 400);
      }
    }
    const records = [];
    for (const item of body.items) records.push(body.operation === "read"
      ? await readDiscoveryDecision(env, item.identity)
      : await saveDiscoveryDecision(env, item.identity, item.decision));
    return json({ ok: "yes", records });
  } catch (error) {
    return json({ error: error.message || "The decisions could not be saved. Retry your selection." }, 400);
  }
}

export const onRequestGet = () => json({ error: "Use the QDP Admin page." }, 405);
