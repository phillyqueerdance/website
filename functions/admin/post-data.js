import { verifyAccess } from "./api.js";

const DEFAULT_APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxvCynlGyqJZqP-l6pG_vf2hFAwc-5sSHL9qftqrb5SCclR_8zeKRCHarKEe6XrPjKd/exec";

export async function onRequestGet(context) {
  try {
    await verifyAccess(context);
    const url = new URL(
      String(context.env.QDP_APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL).trim()
    );
    url.searchParams.set("resource", "events");
    const response = await fetch(url.toString(), {
      redirect: "follow",
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0 }
    });
    if (!response.ok) throw new Error("Event feed could not be loaded.");
    const data = await response.json();
    if (data.error || !Array.isArray(data.events)) {
      throw new Error(data.error || "Event feed is invalid.");
    }
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: /Cloudflare Access|authorized/i.test(error.message) ? 403 : 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
}
