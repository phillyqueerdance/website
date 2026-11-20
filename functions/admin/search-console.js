import { verifyAccess } from "./api.js";
import { json, smallJson } from "../qdp-analytics.js";
import { SEARCH_ORIGIN, SearchError, searchConfigured, searchStatus, saveSearchClient, beginSearchOAuth, disconnectSearch,
  searchRange, searchReport } from "../qdp-search-console.js";

function failure(error) {
  return error instanceof SearchError ? json({ error: error.message, code: error.code }, error.status) :
    json({ error: "Google Search is unavailable. Try again later.", code: "unavailable" }, 503);
}
export async function onRequestGet(context) {
  try { await verifyAccess(context); } catch { return json({ error: "Sign in to QDP Admin again." }, 403); }
  try {
    const url = new URL(context.request.url), status = await searchStatus(context.env);
    if (url.searchParams.get("mode") === "status" || !status.connected) return json(status);
    return json({ ...status, report: await searchReport(context.env, searchRange(url), url.searchParams.has("refresh")) });
  } catch (error) { return failure(error); }
}
export async function onRequestPost(context) {
  const origin = new URL(context.request.url).origin;
  if (origin !== SEARCH_ORIGIN || context.request.headers.get("Origin") !== origin) return json({ error: "Same-origin requests only." }, 403);
  let admin;
  try { admin = await verifyAccess(context); } catch { return json({ error: "Sign in to QDP Admin again." }, 403); }
  if (!searchConfigured(context.env)) return json({ error: "Finish the secure server setup first." }, 503);
  try {
    const body = await smallJson(context.request);
    if (body.action === "configure") { await saveSearchClient(context.env, body); return json({ ok: true }); }
    if (body.action === "connect") {
      const oauth = await beginSearchOAuth(context.env, admin.email);
      const response = json({ url: oauth.url }); response.headers.set("Set-Cookie", oauth.cookie); return response;
    }
    if (body.action === "disconnect") return json({ ok: true, ...await disconnectSearch(context.env) });
    return json({ error: "Choose a Google Search action." }, 400);
  } catch (error) { return failure(error); }
}
