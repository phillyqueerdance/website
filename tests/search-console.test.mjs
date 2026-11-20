import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as search from '../functions/qdp-search-console.js';
import { onRequestGet, onRequestPost } from '../functions/admin/search-console.js';
import { onRequestGet as callback } from '../functions/admin/search-console-callback.js';
import { json, smallJson } from '../functions/qdp-analytics.js';

const now = Date.parse('2026-11-20T18:00:00Z'), owner = 'owner@example.com';
const client = { clientId: '123456-qdp-test.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret-123456' };
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0002_search_console.sql', import.meta.url), 'utf8'));
  const db = { prepare(text) {
    function statement(values = []) {
      const execute = () => ({ results: sql.prepare(text).all(...values), meta: { changes: Number(sql.prepare('SELECT changes() AS n').get().n) } });
      return { bind: (...args) => statement(args), execute, async run() { return execute(); }, async all() { return execute(); }, async first() { return execute().results[0] || null; } };
    } return statement();
  }, async batch(items) { sql.exec('BEGIN'); try { const rows = items.map(item => item.execute()); sql.exec('COMMIT'); return rows; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { sql, env: { QDP_ANALYTICS: db, QDP_ANALYTICS_FREE_PLAN: 'confirmed', QDP_SEARCH_CONSOLE_KEY: Buffer.alloc(32, 17).toString('base64url') } };
}
async function savedClient(h) { await search.saveSearchClient(h.env, client); }
async function connected(h, expiresAt = now + 3600000) {
  await savedClient(h);
  const grant = await search.seal(h.env, { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', expiresAt }, 'grant');
  h.sql.prepare("UPDATE qdp_search_console SET grant_cipher = ?, property = 'sc-domain:queerdancephilly.com', version = 'test-version', connected_at = '2026-11-20T18:00:00Z'").run(grant);
}
const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('Search Console requires the Free-plan gate, database and encryption key; secrets are purpose-bound', async () => {
  const h = fixture();
  for (const env of [{}, { ...h.env, QDP_SEARCH_CONSOLE_KEY: '' }, { ...h.env, QDP_ANALYTICS_FREE_PLAN: 'paid' }]) {
    assert.equal(search.searchConfigured(env), false); assert.equal((await search.searchStatus(env)).connected, false);
  }
  const cipher = await search.seal(h.env, client, 'client');
  assert.equal(cipher.includes(client.clientSecret), false);
  assert.deepEqual(await search.unseal(h.env, cipher, 'client'), client);
  await assert.rejects(search.unseal(h.env, cipher, 'grant'));
  await assert.rejects(search.unseal({ ...h.env, QDP_SEARCH_CONSOLE_KEY: Buffer.alloc(32, 20).toString('base64url') }, cipher, 'client'));
  await savedClient(h);
  const status = await search.searchStatus(h.env);
  assert.equal(status.clientConfigured, true); assert.equal(status.connected, false);
  assert.equal(JSON.stringify(status).includes(client.clientSecret), false);
  assert.equal(h.sql.prepare('SELECT config_cipher FROM qdp_search_console').get().config_cipher.includes(client.clientId), false);
});

test('OAuth is read-only, uses PKCE, offline access and an encrypted HttpOnly cookie', async () => {
  const h = fixture(); await savedClient(h);
  const auth = await search.beginSearchOAuth(h.env, owner, now), url = new URL(auth.url);
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), search.SEARCH_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('redirect_uri'), search.SEARCH_CALLBACK);
  assert.match(auth.cookie, /^__Host-/); assert.match(auth.cookie, /Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal(auth.cookie.includes(owner), false); assert.equal(auth.cookie.includes(client.clientSecret), false);
});

test('OAuth rejects expired, mismatched, cross-admin and replayed callbacks before any token request', async () => {
  const h = fixture(); await savedClient(h);
  const auth = await search.beginSearchOAuth(h.env, owner, now), state = new URL(auth.url).searchParams.get('state');
  const request = (value = state) => new Request(`${search.SEARCH_CALLBACK}?code=test-code&state=${value}`, { headers: { Cookie: auth.cookie.split(';')[0] } });
  let requests = 0; const unused = async () => { requests++; throw new Error('Must not fetch.'); };
  await assert.rejects(search.finishSearchOAuth(h.env, request('wrong'), owner, unused, now), { code: 'expired' });
  await assert.rejects(search.finishSearchOAuth(h.env, request(), 'other@example.com', unused, now), { code: 'expired' });
  await assert.rejects(search.finishSearchOAuth(h.env, request(), owner, unused, now + 600001), { code: 'expired' });
  assert.equal(requests, 0);
  const calls = [];
  const google = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/token')) return reply({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: search.SEARCH_SCOPE });
    return reply({ siteEntry: [{ siteUrl: 'https://unrelated.example/', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:queerdancephilly.com', permissionLevel: 'siteOwner' }] });
  };
  await search.finishSearchOAuth(h.env, request(), owner, google, now);
  assert.equal(calls.length, 2); assert.equal(new URLSearchParams(calls[0].options.body).get('code_verifier').length, 43);
  assert.equal((await search.searchStatus(h.env)).property, 'sc-domain:queerdancephilly.com');
  await assert.rejects(search.finishSearchOAuth(h.env, request(), owner, unused, now), { code: 'expired' });
  assert.equal(requests, 0);
});

test('OAuth does not save access to unrelated sites, unverified properties or broader scopes', async () => {
  for (const scenario of ['unrelated', 'unverified', 'broad']) {
    const h = fixture(); await savedClient(h);
    const auth = await search.beginSearchOAuth(h.env, owner, now), state = new URL(auth.url).searchParams.get('state');
    const request = new Request(`${search.SEARCH_CALLBACK}?code=test&state=${state}`, { headers: { Cookie: auth.cookie.split(';')[0] } });
    const google = async url => url.endsWith('/token') ? reply({ access_token: 'access', refresh_token: 'refresh', scope: scenario === 'broad' ? `${search.SEARCH_SCOPE} https://www.googleapis.com/auth/drive` : search.SEARCH_SCOPE }) :
      reply({ siteEntry: [{ siteUrl: scenario === 'unrelated' ? 'https://example.com/' : 'sc-domain:queerdancephilly.com', permissionLevel: scenario === 'unverified' ? 'siteUnverifiedUser' : 'siteOwner' }] });
    await assert.rejects(search.finishSearchOAuth(h.env, request, owner, google, now), { code: scenario === 'broad' ? 'scope' : 'property' });
    assert.equal((await search.searchStatus(h.env)).connected, false);
  }
});

test('Search dates use Pacific time, a three-day buffer, sixteen-month retention and whole prior periods', () => {
  const url = query => new URL(`https://qdp.example?${query}`);
  const range = search.searchRange(url('days=7'), new Date('2026-11-20T03:00:00Z'));
  assert.equal(range.latest, '2026-11-16'); assert.equal(range.end, '2026-11-16'); assert.equal(range.start, '2026-11-10');
  assert.equal(range.previousStart, '2026-11-03'); assert.equal(range.previousEnd, '2026-11-09');
  assert.equal(search.searchRange(url('days=28'), new Date('2026-03-31T18:00:00Z')).oldest, '2024-11-30');
  assert.equal(search.searchRange(url('from=2025-07-20&to=2026-11-17'), new Date(now)).comparisonAvailable, false);
  for (const query of ['days=nonsense', 'days=0', 'days=999', 'from=2026-02-30&to=2026-03-02', 'from=2025-07-19&to=2026-11-17', 'from=2026-11-18&to=2026-11-18', 'to=2026-11-17']) {
    assert.throws(() => search.searchRange(url(query), new Date(now)), search.SearchError);
  }
});

test('reports use independent Google totals, correct dimensions, final data, safe URLs and a six-hour cache', async () => {
  const h = fixture(); await connected(h);
  const range = search.searchRange(new URL('https://qdp.example?days=7'), new Date(now));
  const calls = [];
  const google = async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body) });
    const request = JSON.parse(options.body), key = request.dimensions[0];
    const total = { clicks: 100, impressions: 1000, ctr: .1, position: 4.2 };
    if (!key) return reply({ rows: [{ ...total, clicks: request.startDate === range.previousStart ? 50 : 100 }] });
    if (key === 'query') return reply({ rows: [{ keys: ['queer dancing'], ...total, clicks: 60 }] });
    if (key === 'page') return reply({ rows: [{ keys: ['https://queerdancephilly.com/?event=SAZ%C3%93N-112026'], ...total }, { keys: ['javascript:alert(1)'], ...total }, { keys: ['https://evil.example/'], ...total }] });
    if (key === 'date') return reply({ rows: [{ keys: [range.end], ...total }] });
    return reply({ rows: [{ keys: ['MOBILE'], ...total }] });
  };
  const result = await search.searchReport(h.env, range, false, google, now);
  assert.equal(result.totals.clicks, 100); assert.equal(result.queries[0].clicks, 60); assert.equal(result.previous.clicks, 50);
  assert.equal(result.pages.length, 1); assert.equal(result.devices[0].name, 'MOBILE'); assert.equal(result.daily.length, 1);
  assert.equal(calls.length, 6);
  for (const call of calls) { assert.equal(call.type, 'web'); assert.equal(call.dataState, 'final'); assert.match(call.url, /sc-domain%3Aqueerdancephilly.com/); assert.equal(call.aggregationType, call.dimensions[0] === 'page' ? 'byPage' : 'byProperty'); }
  assert.equal(JSON.stringify(result).includes('private-access-token'), false);
  const cached = await search.searchReport(h.env, range, false, google, now + 10000); assert.equal(cached.cached, true); assert.equal(calls.length, 6);
  const limited = await search.searchReport(h.env, range, true, google, now + 10000); assert.equal(limited.stale, true); assert.equal(calls.length, 6);
});

test('refreshes are atomic and capped, unavailable prior history is not reported as zero', async () => {
  const h = fixture(); await connected(h, now + 2 * 86400000);
  const range = search.searchRange(new URL('https://qdp.example?days=7'), new Date(now));
  let calls = 0;
  const empty = async () => { calls++; return reply({ rows: [] }); };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => search.searchReport(h.env, range, true, empty, now)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(calls, 6);
  const report = results.find(result => result.status === 'fulfilled').value; assert.equal(report.hasData, false); assert.equal(report.previous, null);
  h.sql.exec("UPDATE qdp_search_console SET report_count = 25, next_fetch_at = 0");
  assert.equal((await search.searchReport(h.env, range, true, empty, now + 60001)).stale, true); assert.equal(calls, 6);
  await search.searchReport(h.env, range, true, empty, now + 86400000); assert.equal(calls, 12);
});

test('expired tokens refresh server-side and disconnect revokes access and clears cached reports', async () => {
  const h = fixture(); await connected(h, now - 1000);
  const range = search.searchRange(new URL('https://qdp.example?days=7'), new Date(now));
  const calls = [];
  const google = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/token')) return reply({ access_token: 'new-access', expires_in: 3600, scope: search.SEARCH_SCOPE });
    return reply({ rows: [] });
  };
  await search.searchReport(h.env, range, false, google, now);
  assert.equal(calls.length, 7); assert.equal(new URLSearchParams(calls[0].options.body).get('refresh_token'), 'private-refresh-token');
  const row = h.sql.prepare('SELECT grant_cipher FROM qdp_search_console').get(); assert.equal(row.grant_cipher.includes('new-access'), false);
  assert.equal((await search.unseal(h.env, row.grant_cipher, 'grant')).accessToken, 'new-access');
  const result = await search.disconnectSearch(h.env, async (url, options) => { assert.equal(url, 'https://oauth2.googleapis.com/revoke'); assert.equal(new URLSearchParams(options.body).get('token'), 'private-refresh-token'); return new Response(null, { status: 200 }); });
  assert.equal(result.revoked, true); assert.equal((await search.searchStatus(h.env)).connected, false);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_search_reports').get().n, 0);
});

test('API rejects unauthenticated access and cross-origin writes before reading data or cookies', async () => {
  const env = fixture().env;
  assert.equal((await onRequestGet({ env, request: new Request(`${search.SEARCH_ORIGIN}/admin/search-console`) })).status, 403);
  assert.equal((await onRequestPost({ env, request: new Request(`${search.SEARCH_ORIGIN}/admin/search-console`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }) })).status, 403);
  const redirect = await callback({ env, request: new Request(`${search.SEARCH_CALLBACK}?code=private`) });
  assert.equal(redirect.status, 303); assert.equal(redirect.headers.get('Location'), `${search.SEARCH_ORIGIN}/admin/analytics?search=unavailable`);
  assert.match(redirect.headers.get('Set-Cookie'), /Max-Age=0/); assert.equal(redirect.headers.get('Referrer-Policy'), 'no-referrer');
});

test('late reports cannot repopulate the cache after disconnect, and Google errors are redacted', async () => {
  const h = fixture(); await connected(h);
  const range = search.searchRange(new URL('https://qdp.example?days=7'), new Date(now));
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const report = search.searchReport(h.env, range, false, async () => { began(); await pending; return reply({ rows: [] }); }, now);
  await started;
  await search.disconnectSearch(h.env, async () => new Response(null, { status: 200 }));
  release(); await report;
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_search_reports').get().n, 0);
  const expired = fixture(); await connected(expired, now - 1000);
  await assert.rejects(search.searchReport(expired.env, range, false, async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private token value' }), { status: 400 }), now), error => error.code === 'reconnect' && !error.message.includes('private token value'));
});

test('authorized setup endpoint never echoes submitted client secrets', async () => {
  const h = fixture();
  const source = readFileSync(new URL('../functions/admin/search-console.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ ...search, json, smallJson, verifyAccess: async () => ({ email: owner }), URL, Request, Response });
  vm.runInContext(source, context);
  const request = new Request(`${search.SEARCH_ORIGIN}/admin/search-console`, { method: 'POST', headers: { Origin: search.SEARCH_ORIGIN }, body: JSON.stringify({ action: 'configure', ...client }) });
  const result = await context.onRequestPost({ env: h.env, request }); assert.equal(result.status, 200); assert.equal((await result.text()).includes(client.clientSecret), false);
});
