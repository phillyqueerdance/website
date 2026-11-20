import { configured as freeConfigured } from "./qdp-analytics.js";

export const SEARCH_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const SEARCH_ORIGIN = "https://queerdancephilly.com";
export const SEARCH_CALLBACK = `${SEARCH_ORIGIN}/admin/search-console-callback`;
export const SEARCH_COOKIE = "__Host-qdp-search-oauth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SITES_URL = "https://www.googleapis.com/webmasters/v3/sites";
const CACHE_MS = 6 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const properties = ["sc-domain:queerdancephilly.com", "https://queerdancephilly.com/", "https://www.queerdancephilly.com/",
  "http://queerdancephilly.com/", "http://www.queerdancephilly.com/"];

export class SearchError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function searchConfigured(env) {
  return freeConfigured(env) && /^[A-Za-z0-9_-]{43}$/.test(env.QDP_SEARCH_CONSOLE_KEY || "");
}
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function bytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted value.");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), ch => ch.charCodeAt(0));
}
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
async function key(env) {
  if (!searchConfigured(env)) throw new SearchError("setup", "Google Search setup is not complete.", 503);
  return crypto.subtle.importKey("raw", bytes(env.QDP_SEARCH_CONSOLE_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env, value, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`qdp-search-v1:${purpose}`) },
    await key(env), encoder.encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(cipher)}`;
}
export async function unseal(env, value, purpose) {
  if (typeof value !== "string" || value.length > 18000) throw new Error("Invalid encrypted value.");
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error("Invalid encrypted value.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(parts[0]), additionalData: encoder.encode(`qdp-search-v1:${purpose}`) },
    await key(env), bytes(parts[1]));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function connection(env) {
  return env.QDP_ANALYTICS.prepare("SELECT * FROM qdp_search_console WHERE id = 1").first();
}
export async function searchStatus(env) {
  if (!searchConfigured(env)) return { configured: false, connected: false, clientConfigured: false, callback: SEARCH_CALLBACK,
    message: "Google Search needs its secure server setup before connecting." };
  const row = await connection(env);
  return { configured: true, connected: Boolean(row?.grant_cipher), clientConfigured: Boolean(row?.config_cipher),
    property: row?.property || null, connectedAt: row?.connected_at || null, callback: SEARCH_CALLBACK };
}
export async function saveSearchClient(env, input) {
  if (!/^[A-Za-z0-9_-]{6,200}\.apps\.googleusercontent\.com$/.test(input.clientId || "") ||
      !/^[A-Za-z0-9_.-]{10,256}$/.test(input.clientSecret || "")) {
    throw new SearchError("client", "Enter the Web application client ID and client secret from Google Cloud.");
  }
  const row = await connection(env);
  if (row?.grant_cipher) throw new SearchError("connected", "Disconnect Google Search before replacing its app credentials.");
  const cipher = await seal(env, { clientId: input.clientId, clientSecret: input.clientSecret }, "client");
  await env.QDP_ANALYTICS.prepare("UPDATE qdp_search_console SET config_cipher = ?, version = ? WHERE id = 1 AND grant_cipher IS NULL")
    .bind(cipher, random()).run();
}
export function oauthCookie(value = "", maxAge = 0) {
  return `${SEARCH_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export async function beginSearchOAuth(env, admin, now = Date.now()) {
  const row = await connection(env);
  if (!row?.config_cipher) throw new SearchError("client", "Save the Google app credentials first.");
  const client = await unseal(env, row.config_cipher, "client");
  const state = random(), verifier = random();
  const session = await seal(env, { state, verifier, admin, version: row.version, expiresAt: now + 600000 }, "oauth");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [name, value] of Object.entries({ client_id: client.clientId, redirect_uri: SEARCH_CALLBACK, response_type: "code",
    scope: SEARCH_SCOPE, access_type: "offline", prompt: "consent select_account", include_granted_scopes: "false", state,
    code_challenge: base64(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))), code_challenge_method: "S256" })) url.searchParams.set(name, value);
  return { url: url.href, cookie: oauthCookie(session, 600) };
}
async function googleJson(fetcher, url, options = {}) {
  const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error === "invalid_grant" || response.status === 401) throw new SearchError("reconnect", "Google access expired or was revoked. Connect Google Search again.", 401);
    if (response.status === 403) throw new SearchError("permission", "Google denied access. Enable the Search Console API in the app's Google Cloud project and use an account with access to QDP's Search Console property.", 403);
    if (response.status === 429) throw new SearchError("quota", "Google's free request limit was reached. Try later; no paid fallback is used.", 429);
    throw new SearchError("google", "Google Search could not respond. Try again later.", 502);
  }
  return body;
}
const tokenOptions = body => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
function grantFrom(body, previous = {}, now = Date.now()) {
  const scopes = String(body.scope || SEARCH_SCOPE).split(/\s+/).filter(Boolean);
  if (!scopes.includes(SEARCH_SCOPE) || scopes.some(scope => scope !== SEARCH_SCOPE)) throw new SearchError("scope", "Google must grant only read-only Search Console access.");
  if (typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 8000 ||
      !(body.refresh_token || previous.refreshToken)) throw new SearchError("reconnect", "Google did not provide ongoing access. Connect Google Search again.");
  const expires = Math.min(3600, Math.max(60, Number(body.expires_in) || 3600));
  return { accessToken: body.access_token, refreshToken: body.refresh_token || previous.refreshToken, expiresAt: now + expires * 1000 };
}
export async function finishSearchOAuth(env, request, admin, fetcher = fetch, now = Date.now()) {
  const url = new URL(request.url), state = url.searchParams.get("state");
  const cookie = (request.headers.get("Cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${SEARCH_COOKIE}=`))?.slice(SEARCH_COOKIE.length + 1);
  let session;
  try { session = await unseal(env, cookie, "oauth"); } catch { throw new SearchError("expired", "The Google connection request expired. Start again from Analytics."); }
  const row = await connection(env);
  if (!state || state !== session.state || session.admin !== admin || session.expiresAt <= now || session.version !== row?.version) {
    throw new SearchError("expired", "The Google connection request expired. Start again from Analytics.");
  }
  if (url.searchParams.has("error")) throw new SearchError("denied", "Google connection was cancelled.");
  const code = url.searchParams.get("code");
  if (!code || code.length > 4096) throw new SearchError("code", "Google did not provide a valid authorization code.");
  const client = await unseal(env, row.config_cipher, "client");
  const body = await googleJson(fetcher, TOKEN_URL, tokenOptions({ client_id: client.clientId, client_secret: client.clientSecret,
    code, code_verifier: session.verifier, redirect_uri: SEARCH_CALLBACK, grant_type: "authorization_code" }));
  const grant = grantFrom(body, {}, now);
  const sites = await googleJson(fetcher, SITES_URL, { headers: { Authorization: `Bearer ${grant.accessToken}` } });
  const allowed = (sites.siteEntry || []).filter(site => site.permissionLevel !== "siteUnverifiedUser").map(site => site.siteUrl);
  const property = properties.find(property => allowed.includes(property));
  if (!property) throw new SearchError("property", "This Google account has no verified QDP Search Console property. Use the account that can view QDP's Search Console reports.");
  const result = await env.QDP_ANALYTICS.prepare(`UPDATE qdp_search_console SET grant_cipher = ?, property = ?, connected_at = ?,
    version = ?, next_fetch_at = 0, report_count = 0, report_day = '' WHERE id = 1 AND version = ?`)
    .bind(await seal(env, grant, "grant"), property, new Date(now).toISOString(), random(), row.version).run();
  if (!result.meta?.changes) throw new SearchError("expired", "The connection changed. Start again from Analytics.");
  await env.QDP_ANALYTICS.prepare("DELETE FROM qdp_search_reports").run();
}
export async function disconnectSearch(env, fetcher = fetch) {
  const row = await connection(env);
  let revoked = true;
  if (row?.grant_cipher) {
    try {
      const grant = await unseal(env, row.grant_cipher, "grant");
      const response = await fetcher("https://oauth2.googleapis.com/revoke", { ...tokenOptions({ token: grant.refreshToken }), redirect: "error", signal: AbortSignal.timeout(10000) });
      revoked = response.ok || response.status === 400;
    } catch { revoked = false; }
  }
  await env.QDP_ANALYTICS.batch([
    env.QDP_ANALYTICS.prepare("UPDATE qdp_search_console SET grant_cipher = NULL, property = NULL, connected_at = NULL, version = ?, next_fetch_at = 0 WHERE id = 1").bind(random()),
    env.QDP_ANALYTICS.prepare("DELETE FROM qdp_search_reports")
  ]);
  return { revoked };
}
const dayValue = day => Date.parse(`${day}T00:00:00Z`);
const shift = (day, count) => new Date(dayValue(day) + count * 86400000).toISOString().slice(0, 10);
const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || "") && Number.isFinite(dayValue(day)) && new Date(dayValue(day)).toISOString().slice(0, 10) === day;
export function searchRange(url, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const oldestDate = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  oldestDate.setUTCMonth(oldestDate.getUTCMonth() - 16);
  const last = new Date(Date.UTC(oldestDate.getUTCFullYear(), oldestDate.getUTCMonth() + 1, 0)).getUTCDate();
  oldestDate.setUTCDate(Math.min(Number(today.slice(8)), last));
  const oldest = oldestDate.toISOString().slice(0, 10), latest = shift(today, -3);
  const days = Number(url.searchParams.get("days") || 28);
  if (!url.searchParams.has("from") && !url.searchParams.has("to") && ![7, 28, 90].includes(days)) {
    throw new SearchError("range", "Choose 7, 28 or 90 days, or enter custom dates.");
  }
  const start = url.searchParams.get("from") || (url.searchParams.has("to") ? "" : shift(latest, 1 - days));
  const end = url.searchParams.get("to") || (url.searchParams.has("from") ? "" : latest);
  if ((!url.searchParams.has("from") && !url.searchParams.has("to") && ![7, 28, 90].includes(days)) ||
      !validDay(start) || !validDay(end) || start > end || start < oldest || end > latest) {
    throw new SearchError("range", `Choose dates from ${oldest} through ${latest}. Google Search uses Pacific time and this report leaves the latest three days for processing.`);
  }
  const length = (dayValue(end) - dayValue(start)) / 86400000 + 1;
  const previousStart = shift(start, -length), previousEnd = shift(start, -1);
  return { start, end, days: length, oldest, latest, previousStart, previousEnd, comparisonAvailable: previousStart >= oldest };
}
export function searchMetrics(row) {
  const nonnegative = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const clicks = nonnegative(row?.clicks), impressions = nonnegative(row?.impressions);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0,
    position: impressions && Number.isFinite(Number(row?.position)) && Number(row.position) > 0 ? Number(row.position) : null };
}
export function safeSearchPage(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["queerdancephilly.com", "www.queerdancephilly.com"].includes(url.hostname) &&
      !url.username && !url.password && value.length <= 2048 ? url.href : null;
  } catch { return null; }
}
export async function searchReport(env, range, refresh = false, fetcher = fetch, now = Date.now()) {
  const row = await connection(env);
  if (!row?.grant_cipher || !properties.includes(row.property)) throw new SearchError("disconnected", "Connect Google Search to see QDP's search reports.");
  const db = env.QDP_ANALYTICS, cacheKey = `${row.version}:${range.start}:${range.end}`;
  const cached = await db.prepare("SELECT payload, fetched_at FROM qdp_search_reports WHERE cache_key = ?").bind(cacheKey).first();
  if (cached && !refresh && now - cached.fetched_at < CACHE_MS) return { ...JSON.parse(cached.payload), cached: true };
  const utcDay = new Date(now).toISOString().slice(0, 10);
  const claim = await db.prepare(`UPDATE qdp_search_console SET next_fetch_at = ?, report_day = ?,
    report_count = CASE WHEN report_day = ? THEN report_count + 1 ELSE 1 END
    WHERE id = 1 AND version = ? AND next_fetch_at <= ? AND (report_day <> ? OR report_count < 25) RETURNING id`)
    .bind(now + 60000, utcDay, utcDay, row.version, now, utcDay).first();
  if (!claim) {
    if (cached) return { ...JSON.parse(cached.payload), cached: true, stale: true, notice: "Refresh is limited to once a minute and 25 reports per UTC day. Showing the last saved report." };
    throw new SearchError("limit", "Wait a minute before loading another report. Google Search also has a 25-report daily limit to keep requests bounded.", 429);
  }
  let grant = await unseal(env, row.grant_cipher, "grant");
  if (grant.expiresAt < now + 60000) {
    const client = await unseal(env, row.config_cipher, "client");
    const result = await googleJson(fetcher, TOKEN_URL, tokenOptions({ client_id: client.clientId, client_secret: client.clientSecret,
      refresh_token: grant.refreshToken, grant_type: "refresh_token" }));
    grant = grantFrom(result, grant, now);
    const saved = await db.prepare("UPDATE qdp_search_console SET grant_cipher = ? WHERE id = 1 AND version = ?")
      .bind(await seal(env, grant, "grant"), row.version).run();
    if (!saved.meta?.changes) throw new SearchError("disconnected", "The Google connection changed. Refresh the page.");
  }
  const query = (startDate, endDate, dimensions, rowLimit) => googleJson(fetcher, `${SITES_URL}/${encodeURIComponent(row.property)}/searchAnalytics/query`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${grant.accessToken}` },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, type: "web", dataState: "final", aggregationType: dimensions.includes("page") ? "byPage" : "byProperty" })
  });
  const [totals, previous, daily, queries, pages, devices] = await Promise.all([
    query(range.start, range.end, [], 1), range.comparisonAvailable ? query(range.previousStart, range.previousEnd, [], 1) : Promise.resolve(null),
    query(range.start, range.end, ["date"], 500), query(range.start, range.end, ["query"], 101),
    query(range.start, range.end, ["page"], 101), query(range.start, range.end, ["device"], 3)
  ]);
  const payload = { property: row.property, range, fetchedAt: new Date(now).toISOString(), cached: false,
    totals: searchMetrics(totals.rows?.[0]), previous: previous?.rows?.length ? searchMetrics(previous.rows[0]) : null,
    hasData: Boolean(totals.rows?.length),
    daily: (daily.rows || []).filter(item => validDay(item.keys?.[0]) && item.keys[0] >= range.start && item.keys[0] <= range.end)
      .map(item => ({ day: item.keys[0], ...searchMetrics(item) })).sort((a, b) => a.day.localeCompare(b.day)),
    queries: (queries.rows || []).slice(0, 100).map(item => ({ name: String(item.keys?.[0] || "").slice(0, 256), ...searchMetrics(item) })),
    pages: (pages.rows || []).slice(0, 100).filter(item => safeSearchPage(item.keys?.[0])).map(item => ({ name: safeSearchPage(item.keys[0]), ...searchMetrics(item) })),
    devices: (devices.rows || []).filter(item => ["DESKTOP", "MOBILE", "TABLET"].includes(item.keys?.[0])).map(item => ({ name: item.keys[0], ...searchMetrics(item) })),
    moreQueries: (queries.rows?.length || 0) > 100, morePages: (pages.rows?.length || 0) > 100 };
  // A late response must not repopulate cached data after disconnecting or replacing the connection.
  await db.prepare(`INSERT INTO qdp_search_reports (cache_key, payload, fetched_at)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM qdp_search_console WHERE id = 1 AND version = ? AND grant_cipher IS NOT NULL)
    ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`)
    .bind(cacheKey, JSON.stringify(payload), now, row.version).run();
  await db.prepare(`DELETE FROM qdp_search_reports WHERE cache_key NOT IN
    (SELECT cache_key FROM qdp_search_reports ORDER BY fetched_at DESC LIMIT 24) OR fetched_at < ?`).bind(now - 30 * 86400000).run();
  return payload;
}
