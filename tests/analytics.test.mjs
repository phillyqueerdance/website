import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as analytics from '../functions/qdp-analytics.js';
import { onRequestGet as config, onRequestPost as ingest } from '../functions/api/analytics.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/admin/analytics-data.js';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_analytics.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(text) {
      function statement(values = []) {
        const execute = () => {
          const results = sql.prepare(text).all(...values);
          return { success: true, results, meta: { changes: Number(sql.prepare('SELECT changes() AS n').get().n) } };
        };
        return { bind: (...args) => statement(args), execute,
          async all() { return execute(); }, async first() { return execute().results[0] || null; }, async run() { return execute(); } };
      }
      return statement();
    },
    async batch(statements) {
      sql.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    }
  };
  return { sql, db, env: { QDP_ANALYTICS: db, QDP_ANALYTICS_FREE_PLAN: 'confirmed' } };
}
const now = new Date('2026-11-20T15:00:00Z');
const visit = { metric: 'visit', kind: '', id: '', label: '', source: 'instagram.com', device: 'mobile', n: 1 };
const open = (id = 'SAZÓN-112026', source = 'calendar') => ({ metric: 'event_open', kind: 'event', id,
  label: 'Sazón & Friends', source, device: '', n: 1 });
function post(env, body, origin = 'https://queerdancephilly.com') {
  return ingest({ env, request: new Request('https://queerdancephilly.com/api/analytics', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }) });
}

test('analytics stays off until the database and Free-plan confirmation are both present', async () => {
  const h = fixture();
  for (const env of [{}, { QDP_ANALYTICS: h.db }, { QDP_ANALYTICS_FREE_PLAN: 'confirmed' }, { ...h.env, QDP_ANALYTICS_FREE_PLAN: 'paid' }]) {
    assert.equal((await (await config({ env })).json()).enabled, false);
    assert.equal((await post(env, { v: 1, items: [visit] })).status, 503);
  }
  assert.equal((await (await config({ env: h.env })).json()).enabled, true);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_analytics_counts').get().n, 0);
});

test('ingestion rejects cross-origin, oversized and invalid batches before writing', async () => {
  const h = fixture();
  assert.equal((await post(h.env, { v: 1, items: [visit] }, 'https://evil.example')).status, 403);
  assert.equal((await post(h.env, { v: 1, items: [visit] }, '')).status, 403);
  for (const body of [{}, { v: 9, items: [visit] }, { v: 1, items: [] }, { v: 1, items: Array(25).fill(visit) },
    { v: 1, items: [{ ...visit, metric: 'unknown' }] }, { v: 1, items: [{ ...visit, n: 51 }] },
    { v: 1, items: [{ ...visit, source: 'https://private.example/path?email=private' }] },
    { v: 1, items: [visit], extra: 'é'.repeat(10000) }]) assert.equal((await post(h.env, body)).status, 400);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_analytics_budget').get().n, 0);
});

test('normalization preserves accented EventIDs but never stores raw URLs, search text, IPs or visitor identifiers', () => {
  const input = { ...open(), ip: '127.0.0.1', visitorId: 'private', search: 'private search', url: 'https://private.example/path', n: 2 };
  const result = analytics.normalizeItems([input, { ...open(), n: 3 }, { ...open(), id: '../private' }]);
  assert.deepEqual(result, [{ ...open(), n: 5 }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(analytics.normalizeItems([{ ...visit, source: '192.168.0.1' }])[0].source, 'direct-unknown');
  assert.equal(analytics.normalizeItems([{ metric: 'search_use', kind: 'artists', source: 'artists', label: 'private search text' }])[0].label, '');
});

test('real SQLite rollups accumulate counts, retain titles and return per-event action sources', async () => {
  const h = fixture();
  assert.equal(await analytics.collect(h.env, [visit, open(), { ...open(), source: 'scene-map', n: 2 }], now), true);
  assert.equal(await analytics.collect(h.env, [{ ...open(), label: '', n: 3 }], now), true);
  const range = analytics.dateRange(new URL('https://qdp.example?days=7'), now);
  const data = await analytics.readAnalytics(h.env, range, now);
  assert.equal(data.totals.current.visit, 1);
  assert.equal(data.totals.current.event_open, 6);
  assert.equal(data.events[0].id, 'SAZÓN-112026');
  assert.equal(data.events[0].name, 'Sazón & Friends');
  assert.equal(data.events[0].opens, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(data.sources)), [{ name: 'instagram.com', total: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(data.devices)), [{ name: 'mobile', total: 1 }]);
  assert.equal(data.series[0].visits, null);
  assert.equal(data.series.at(-1).visits, 1);
  assert.equal(data.series.at(-1).partial, true);
  assert.equal(data.comparisonAvailable, false);
  const detail = await analytics.readEventBreakdown(h.env, range, 'SAZÓN-112026');
  assert.deepEqual(JSON.parse(JSON.stringify(detail.rows)), [
    { metric: 'event_open', source: 'calendar', total: 4 }, { metric: 'event_open', source: 'scene-map', total: 2 }
  ]);
});

test('simultaneous batches stop at the atomic daily budget without losing or overspending counts', async () => {
  const h = fixture(), utcDay = now.toISOString().slice(0, 10);
  h.sql.prepare('INSERT INTO qdp_analytics_budget (day, units) VALUES (?, ?)').run(utcDay, analytics.DAILY_WRITE_BUDGET - 16);
  const results = await Promise.all(Array.from({ length: 20 }, () => analytics.collect(h.env, [visit], now)));
  assert.equal(results.filter(Boolean).length, 2);
  const budget = h.sql.prepare('SELECT * FROM qdp_analytics_budget WHERE day = ?').get(utcDay);
  assert.equal(budget.units, analytics.DAILY_WRITE_BUDGET);
  assert.equal(budget.limited, 1);
  assert.equal(h.sql.prepare('SELECT total FROM qdp_analytics_counts').get().total, 2);
  const data = await analytics.readAnalytics(h.env, analytics.dateRange(new URL('https://qdp.example?days=1'), now), now);
  assert.equal(data.series[0].partial, true);
});

test('a failed D1 transaction rolls back the budget claim; a paused collector does not add counters', async () => {
  const h = fixture();
  h.sql.exec('DROP TABLE qdp_analytics_counts');
  await assert.rejects(analytics.collect(h.env, [visit], now));
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_analytics_budget').get().n, 0);
  const paused = fixture();
  paused.sql.exec('UPDATE qdp_analytics_settings SET enabled = 0');
  assert.equal(await analytics.collect(paused.env, [visit], now), false);
  assert.equal(paused.sql.prepare('SELECT COUNT(*) AS n FROM qdp_analytics_counts').get().n, 0);
});

test('Philadelphia days and previous-period arithmetic stay correct across DST and UTC midnight', () => {
  assert.equal(analytics.phillyDay(new Date('2026-11-20T03:30:00Z')), '2026-11-19');
  assert.equal(analytics.phillyDay(new Date('2026-03-08T04:30:00Z')), '2026-03-07');
  const range = analytics.dateRange(new URL('https://qdp.example?from=2026-03-07&to=2026-03-09'), now);
  assert.deepEqual(range, { start: '2026-03-07', end: '2026-03-09', days: 3, previousStart: '2026-03-04', previousEnd: '2026-03-06', today: '2026-11-20' });
  for (const query of ['from=2026-02-30&to=2026-03-02', 'to=nonsense', 'days=100', 'from=2026-01-01', 'to=2027-01-01', 'from=2026-11-21&to=2026-11-20']) {
    assert.throws(() => analytics.dateRange(new URL('https://qdp.example?' + query), now));
  }
});

test('a manual pause is retained as a known gap after collection resumes', async () => {
  const h = fixture();
  await analytics.collect(h.env, [visit], new Date('2026-11-01T15:00:00Z'));
  h.sql.exec("INSERT INTO qdp_analytics_gaps (started_at, ended_at) VALUES ('2026-11-18T22:00:00Z', '2026-11-19T16:00:00Z')");
  const data = await analytics.readAnalytics(h.env, analytics.dateRange(new URL('https://qdp.example?days=7'), now), now);
  assert.equal(data.series.find(row => row.day === '2026-11-18').partial, true);
  assert.equal(data.series.find(row => row.day === '2026-11-19').partial, true);
  assert.equal(data.series.find(row => row.day === '2026-11-17').partial, false);
  assert.equal(data.comparisonAvailable, false);
});

test('authentication is checked before private analytics or its cache can be read', async () => {
  const h = fixture();
  const request = new Request('https://qdp.example/admin/analytics-data');
  const response = await adminGet({ request, env: h.env });
  assert.equal(response.status, 403);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal((await adminPost({ request: new Request(request.url, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }), env: h.env })).status, 403);
});

test('authorized pause and resume use the private endpoint and preserve the gap transactionally', async () => {
  const h = fixture();
  const source = readFileSync(new URL('../functions/admin/analytics-data.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ ...analytics, verifyAccess: async () => ({ email: 'fixture@example.com' }),
    URL, Request, Response, Date, console });
  vm.runInContext(source, context);
  async function call(enabled) {
    return context.onRequestPost({ env: h.env, request: new Request('https://qdp.example/admin/analytics-data', {
      method: 'POST', headers: { Origin: 'https://qdp.example' }, body: JSON.stringify({ enabled })
    }) });
  }
  assert.equal((await call(false)).status, 200);
  assert.equal(h.sql.prepare('SELECT enabled FROM qdp_analytics_settings').get().enabled, 0);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_analytics_gaps WHERE ended_at IS NULL').get().n, 1);
  assert.equal((await call(true)).status, 200);
  assert.equal(h.sql.prepare('SELECT enabled FROM qdp_analytics_settings').get().enabled, 1);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM qdp_analytics_gaps WHERE ended_at IS NULL').get().n, 0);
});
