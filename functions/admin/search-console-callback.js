import { verifyAccess } from "./api.js";
import { SEARCH_ORIGIN, SearchError, finishSearchOAuth, oauthCookie } from "../qdp-search-console.js";

export async function onRequestGet(context) {
  let result = "connected";
  try {
    const admin = await verifyAccess(context);
    await finishSearchOAuth(context.env, context.request, admin.email);
  } catch (error) { result = error instanceof SearchError ? error.code : "unavailable"; }
  return new Response(null, { status: 303, headers: { Location: `${SEARCH_ORIGIN}/admin/analytics?search=${encodeURIComponent(result)}`,
    "Set-Cookie": oauthCookie(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
