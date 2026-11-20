import { configured, collect, normalizeItems, smallJson, json } from "../qdp-analytics.js";

export async function onRequestGet({ env }) {
  if (!configured(env)) return json({ enabled: false }, 200, "public, max-age=300");
  try {
    const settings = await env.QDP_ANALYTICS.prepare("SELECT enabled FROM qdp_analytics_settings WHERE id = 1").first();
    return json({ enabled: Boolean(settings?.enabled) }, 200, "public, max-age=300");
  } catch { return json({ enabled: false }, 200, "no-store"); }
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) return json({ error: "Same-origin requests only." }, 403);
  if (!configured(env)) return json({ enabled: false }, 503);
  if (/bot|crawler|spider|headless/i.test(request.headers.get("User-Agent") || "")) return new Response(null, { status: 204 });
  let items;
  try {
    const body = await smallJson(request);
    if (body.v !== 1) throw new Error("Unsupported analytics format.");
    items = normalizeItems(body.items);
    if (!items.length) throw new Error("Empty analytics batch.");
  } catch { return json({ error: "Invalid analytics batch." }, 400); }
  try {
    if (!await collect(env, items)) return json({ enabled: false, limited: true }, 429);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    // Analytics must never cause a paid fallback or a public-site failure.
    return json({ enabled: false, unavailable: true }, 503);
  }
}
