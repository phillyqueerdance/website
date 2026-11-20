import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../analytics.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const storage = entries => {
  const values = new Map(entries || []);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
function setup({ excluded = false, dnt, gpc, host = 'queerdancephilly.com', enabled = true,
  response = 204, session = storage(), impressions = false } = {}) {
  const requests = [], timers = new Map(), documentEvents = new Map(), windowEvents = new Map();
  let nextTimer = 0, clock = Date.parse('2026-11-20T15:00:00Z'), intersection;
  const local = storage(excluded ? [['qdp-analytics-exclude', '1']] : []);
  const location = new URL(`https://${host}/?utm_source=instagram&private=not-recorded`);
  const cards = [];
  const document = { referrer: 'https://instagram.com/private/path?private=not-recorded', visibilityState: 'visible',
    getElementById: id => id === 'poster' ? {} : null,
    querySelectorAll: () => cards, querySelector: () => null,
    addEventListener: (type, callback) => { const list = documentEvents.get(type) || []; list.push(callback); documentEvents.set(type, list); }
  };
  const window = { addEventListener: (type, callback) => windowEvents.set(type, callback),
    QDPEventMetadata: { cleanTitle: event => event.title } };
  if (impressions) {
    window.IntersectionObserver = class { constructor(callback) { intersection = callback; } observe() {} unobserve() {} };
    window.MutationObserver = class { observe() {} };
  }
  const context = vm.createContext({ window, document, location, navigator: { userAgent: 'Firefox', doNotTrack: dnt, globalPrivacyControl: gpc },
    URL, URLSearchParams, Blob, Map, Set, localStorage: local, sessionStorage: session,
    Date: class extends Date { static now() { return clock; } },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    IntersectionObserver: window.IntersectionObserver, MutationObserver: window.MutationObserver,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return options?.method === 'POST' ? new Response(null, { status: response }) : Response.json({ enabled });
    }
  });
  vm.runInContext(source, context);
  async function run(delay) {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    await settle();
  }
  return { api: window.QDPAnalytics, requests, local, session, run, cards,
    advance: amount => { clock += amount; },
    intersect: entries => intersection(entries),
    items: () => requests.filter(row => row.options?.method === 'POST').flatMap(row => JSON.parse(row.options.body).items)
  };
}

test('the client batches one visit, successful views, and source-attributed event opens without sending query strings', async () => {
  const h = setup(); await settle();
  h.api.view('calendar');
  h.api.view('event', 'SAZÓN-112026', 'Sazón & Friends');
  h.api.view('event', 'SAZÓN-112026', 'Sazón & Friends');
  h.api.track('link_copy', { kind: 'event', id: 'SAZÓN-112026', label: 'Sazón & Friends', secret: 'not-recorded' });
  await h.run(12000);
  const items = h.items();
  assert.equal(items.find(item => item.metric === 'visit').source, 'instagram.com');
  assert.equal(items.find(item => item.metric === 'event_open').n, 1);
  assert.equal(items.find(item => item.metric === 'event_open').source, 'calendar');
  assert.equal(items.find(item => item.metric === 'link_copy').source, 'event');
  assert.equal(JSON.stringify(items).includes('not-recorded'), false);
  assert.ok(h.requests.every(row => row.url === '/api/analytics'));
  assert.deepEqual([...h.session.values.keys()], ['qdp-analytics-last-activity']);
  assert.equal(h.local.values.size, 0);
});

test('owner exclusion, privacy signals and preview hosts make no analytics requests or session writes', async () => {
  for (const options of [{ excluded: true }, { dnt: '1' }, { gpc: true }, { host: 'preview.website.pages.dev' }]) {
    const h = setup(options);
    h.api.view('calendar'); h.api.view('event', 'ONE', 'Night');
    await settle(); await h.run(12000);
    assert.equal(h.requests.length, 0);
    assert.equal(h.session.values.size, 0);
  }
});

test('reloads do not inflate tab visits; 30 minutes of inactivity permits a new visit', async () => {
  const session = storage(), first = setup({ session }); await settle();
  first.api.view('calendar'); await first.run(12000);
  assert.equal(first.items().find(item => item.metric === 'visit').n, 1);
  const second = setup({ session }); await settle();
  second.api.view('calendar'); await second.run(12000);
  assert.equal(second.items().some(item => item.metric === 'visit'), false);
  second.advance(31 * 60 * 1000);
  second.api.view('artist', 'ARTIST-001', 'Artist'); await second.run(12000);
  assert.equal(second.items().find(item => item.metric === 'visit').n, 1);
});

test('disabled collection and quota errors stop further sends without retries', async () => {
  const disabled = setup({ enabled: false }); await settle();
  disabled.api.view('calendar'); await disabled.run(12000);
  assert.equal(disabled.requests.length, 1);
  const limited = setup({ response: 429 }); await settle();
  limited.api.view('calendar'); await limited.run(12000);
  limited.api.view('event', 'ONE', 'Night'); await limited.run(12000);
  assert.equal(limited.requests.filter(row => row.options?.method === 'POST').length, 1);
});

test('impressions require half visibility and dwell time, exclude obscured cards, and deduplicate a section', async () => {
  const h = setup({ impressions: true }); await settle(); h.api.view('calendar');
  let hidden = true;
  const card = { dataset: { eventId: 'ONE' }, isConnected: true,
    closest: () => hidden ? {} : null, querySelector: () => ({ textContent: 'Night' }) };
  const entry = ratio => ({ target: card, isIntersecting: true, intersectionRatio: ratio });
  h.intersect([entry(.8)]); await h.run(800);
  hidden = false;
  h.intersect([entry(.4)]); await h.run(800);
  h.intersect([entry(.8)]); await h.run(800);
  h.intersect([entry(.8)]); await h.run(800);
  await h.run(12000);
  const impression = h.items().find(item => item.metric === 'event_impression');
  assert.equal(impression.n, 1); assert.equal(impression.id, 'ONE'); assert.equal(impression.source, 'calendar');
});

test('share hooks distinguish a canceled native dialog from a successful clipboard copy', async () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const shareSource = app.slice(app.indexOf('async function shareEvent('), app.indexOf('\nfunction fitDetailContent'));
  async function share({ native, clipboardFails = false } = {}) {
    const tracked = [], status = {};
    const ctx = vm.createContext({ navigator: native ? { share: native } : {},
      window: { QDPAnalytics: { event: (metric, event) => tracked.push([metric, event.id]) } },
      eventIdOf: item => item.id, eventShareUrl: id => 'https://qdp.example/?event=' + id,
      displayTitle: item => item.title, copyEventLink: async () => { if (clipboardFails) throw new Error('Clipboard denied'); },
      setTimeout() {} });
    vm.runInContext(shareSource, ctx);
    await ctx.shareEvent({ id: 'ONE', title: 'Night' }, status);
    return { tracked, status };
  }
  assert.deepEqual((await share()).tracked, [['link_copy', 'ONE']]);
  assert.deepEqual((await share({ clipboardFails: true })).tracked, []);
  assert.deepEqual((await share({ native: async () => { throw Object.assign(new Error('Canceled'), { name: 'AbortError' }); } })).tracked, [['share_open', 'ONE']]);
  assert.deepEqual((await share({ native: async () => {} })).tracked, [['share_open', 'ONE']]);
});
