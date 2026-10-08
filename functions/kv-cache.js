// Share KV records across endpoints without extending the lifetime of responses
// built from them. Versioned archive records stay reusable while the manifest
// remains the authority for publication, removals, and the current version.
const SCOPE = Symbol("qdpKvReads");
const pendingByCache = new WeakMap();
const UNTIL = "X-QDP-Cache-Until";
const ARCHIVE_PREFIX = "qdp-archive:v1:";

export function withKvScope(context) {
  return context[SCOPE] ? context : {
    ...context, [SCOPE]: { reads: new Map(), deadline: Infinity }
  };
}

function cacheKey(context, kv, key, version) {
  const url = new URL("/_qdp/kv-record", context.request.url);
  url.searchParams.set("binding", kv === context.env?.QDP_PUBLIC_FEED_KV
    ? "QDP_PUBLIC_FEED_KV" : "QDP_ARCHIVE_KV");
  url.searchParams.set("key", key);
  if (version) url.searchParams.set("version", version);
  return new Request(url.href);
}

export async function readKvJson(context, kv, key, {
  seconds = 60, version = "", valid = value => value && typeof value === "object"
} = {}) {
  if (!kv) return null;
  const request = cacheKey(context, kv, key, version);
  const scope = context[SCOPE];
  const cache = typeof caches === "undefined" ? null : caches.default;
  const owner = cache || kv;
  let pending = pendingByCache.get(owner);
  if (!pending) pendingByCache.set(owner, pending = new Map());
  let promise = scope?.reads.get(request.url) || pending.get(request.url);
  if (!promise) {
    promise = (async () => {
      const hit = await cache?.match(request);
      if (hit) {
        try {
          const envelope = await hit.json();
          if (Number.isFinite(envelope.until) && envelope.until > Date.now() && valid(envelope.value)) {
            return envelope;
          }
        } catch (_) { /* An unreadable cache entry must not hide valid KV data. */ }
      }
      const value = await kv.get(key, "json");
      if (!valid(value)) return { value: null, until: Infinity };
      const envelope = { value, until: Date.now() + seconds * 1000 };
      if (cache) {
        try {
          await cache.put(request, Response.json(envelope, {
            headers: { "Cache-Control": `public, max-age=${seconds}` }
          }));
        } catch (error) { console.warn("QDP record cache unavailable:", error); }
      }
      return envelope;
    })();
    pending.set(request.url, promise);
    promise.finally(() => {
      if (pending.get(request.url) === promise) pending.delete(request.url);
    }).catch(() => {});
  }
  scope?.reads.set(request.url, promise);
  const result = await promise;
  if (scope && result.value) scope.deadline = Math.min(scope.deadline, result.until);
  return result.value;
}

export function cacheResponse(context, response, seconds) {
  if (response.status !== 200) return response;
  const existing = Number(response.headers.get(UNTIL)) || Infinity;
  const until = Math.min(existing, context[SCOPE]?.deadline ?? Infinity,
    Date.now() + seconds * 1000);
  const headers = new Headers(response.headers);
  headers.set(UNTIL, String(until));
  headers.set("Cache-Control", `public, max-age=${Math.max(0, Math.floor((until - Date.now()) / 1000))}`);
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers
  });
}

export function inheritCacheDeadline(context, response) {
  const until = Number(response.headers.get(UNTIL));
  if (context[SCOPE] && Number.isFinite(until) && until > 0) {
    context[SCOPE].deadline = Math.min(context[SCOPE].deadline, until);
  }
}

export function freshResponse(response, context) {
  if (!response) return null;
  const until = Number(response.headers.get(UNTIL));
  // Existing deployments have no absolute deadline; their original edge TTL
  // still applies during rollout.
  if (!until) return response;
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  if (context) inheritCacheDeadline(context, response);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${Math.max(0, Math.floor((until - Date.now()) / 1000))}`);
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers
  });
}

export function readArchiveManifest(context, kv) {
  return readKvJson(context, kv, ARCHIVE_PREFIX + "manifest", {
    seconds: 60,
    valid: value => value?.schema === 1 && typeof value.revision === "string" && Boolean(value.revision)
  });
}

export function archiveRecordRevision(manifest, key) {
  const revision = Object.hasOwn(manifest, "recordIndexVersion")
    ? manifest.recordIndexVersion === 1 && manifest.recordRevisions?.[key]
    : manifest.revision;
  return typeof revision === "string" && /^[\w-]{1,128}$/.test(revision) ? revision : null;
}

export function readArchiveRecord(context, kv, manifest, key) {
  const version = archiveRecordRevision(manifest, key);
  if (!version) return Promise.resolve(null);
  return readKvJson(context, kv, ARCHIVE_PREFIX + key, {
    seconds: 3600, version,
    valid: value => value?.revision === version
  });
}
