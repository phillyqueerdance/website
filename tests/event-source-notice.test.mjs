import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet as liveApi, readPreparedEvents } from '../functions/api/events.js';
import { onRequestGet as archiveApi, publicEvent } from '../functions/api/archive.js';
import { onRequestGet as eventApi } from '../functions/api/event.js';
import { renderEventDetail, renderEventPage } from '../functions/event-page.js';
import { onRequestGet as homePage } from '../functions/index.js';
import { shard } from '../functions/event-records.js';

const meta = globalThis.QDPEventMetadata;
const original = { eventId: 'SAZÓNP-102926', public: true, title: 'A public party',
  start: '2099-10-29T22:00:00-04:00', end: '2099-10-30T02:00:00-04:00',
  venue: 'The Room', venueId: 'ROOM', address: '123 Market St',
  artistIds: ['ARTIST'], partyId: 'PARTY', collectiveIds: ['CREW'],
  description: 'The complete event description.\n\nA second paragraph stays intact.' };

function fixture() {
  const manifest = { schema: 1, revision: 'notice', eventIndexVersion: 1, eventShards: 8,
    eventIds: [original.eventId], artists: ['ARTIST'], venues: ['ROOM'], parties: ['PARTY'],
    collectives: ['CREW'], months: ['2099-10'], partyPublicGate: true };
  const records = new Map([
    ['qdp-archive:v1:manifest', manifest],
    [`qdp-archive:v1:event:${shard(original.eventId, 8)}`, { revision: 'notice', entries: { [original.eventId]: original } }],
    ['qdp-live:v1:feed', { schema: 1, publishedAt: new Date().toISOString(), payload: { events: [original] } }]
  ]);
  for (const [kind, id, count] of [['artist', 'ARTIST', 4], ['venue', 'ROOM', 2],
    ['party', 'PARTY', 2], ['collective', 'CREW', 2], ['month', '2099-10', 4]]) {
    records.set(`qdp-archive:v1:${kind}:${shard(id, count)}`, { revision: 'notice', entries: {
      [id]: { profile: { id, name: id, publicOk: true }, events: [original] }
    } });
  }
  return path => ({ request: new Request('https://preview.example' + path),
    env: { QDP_ARCHIVE_KV: { get: async key => records.get(key) || null } } });
}

function checkExport(event) {
  assert.ok(event.description.startsWith(meta.sourceNotice + '\nOriginal listing: '));
  assert.ok(event.description.includes(meta.url(original.eventId)));
  assert.equal(meta.displayDescription(event.description), original.description);
  assert.equal(event.description.split(meta.sourceNotice).length, 2);
}

test('prepared, fallback, and cached public JSON descriptions carry exactly one notice without changing source records', async t => {
  const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
  t.after(() => Object.assign(globalThis, previous));
  const edge = new Map();
  globalThis.caches = { default: {
    match: async key => edge.get(key.url)?.clone(),
    put: async (key, response) => edge.set(key.url, response.clone())
  } };
  globalThis.fetch = async () => Response.json({ events: [original] });
  const context = fixture();
  for (let i = 0; i < 2; i++) checkExport((await (await liveApi(context('/api/events'))).json()).events[0]);
  assert.equal((await readPreparedEvents(context('/api/events'))).events[0].description, original.description);
  edge.clear();
  checkExport((await (await liveApi({ request: new Request('https://fallback.example/api/events'), env: {} })).json()).events[0]);
  for (const [kind, id] of [['artist', 'ARTIST'], ['venue', 'ROOM'], ['party', 'PARTY'], ['collective', 'CREW'], ['month', '2099-10']]) {
    const path = `/api/archive?resource=${kind}&${kind === 'month' ? 'month' : 'id'}=${id}`;
    for (let i = 0; i < 2; i++) checkExport((await (await archiveApi(context(path))).json()).events[0]);
  }
  checkExport((await (await archiveApi({ request: new Request('https://fallback.example/api/archive?resource=month&month=2099-10'), env: {} })).json()).events[0]);
  checkExport((await (await eventApi(context('/api/event?event=' + encodeURIComponent(original.eventId)))).json()).event);
  const exported = meta.exportEvent(original);
  assert.deepEqual(meta.exportEvent(exported), exported, 're-exporting must not accumulate notices');
  assert.equal(publicEvent(exported).description, original.description, 'internal event lookup stays clean');
  assert.equal(original.description.startsWith(meta.sourceNotice), false, 'source data must not be mutated');
});

test('QDP server HTML, previews, structured data, and legitimate calendar links retain only the original copy', () => {
  const exported = meta.exportEvent(original);
  const html = renderEventDetail(exported, meta.url(original.eventId));
  assert.ok(html.includes(original.description));
  assert.equal(html.includes(meta.sourceNotice), false);
  assert.equal(meta.schema(exported).description, original.description);
  assert.equal(meta.description(exported), meta.description(original));
  for (const description of ['', undefined]) {
    const empty = meta.exportEvent({ ...original, description });
    assert.equal(meta.displayDescription(empty.description), '');
    assert.equal(renderEventDetail(empty, meta.url(original.eventId)).includes(meta.sourceNotice), false);
  }
});

test('initial JSON contains the notice while both initial HTML and browser-normalized event copy exclude it', async t => {
  const previous = globalThis.HTMLRewriter;
  t.after(() => { globalThis.HTMLRewriter = previous; });
  const written = new Map();
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) handler.element({
        setInnerContent: content => written.set(selector, content),
        setAttribute() {}, removeAttribute() {}, remove() {}, append() {}
      });
      return response;
    }
  };
  const context = fixture();
  const home = context('/');
  home.env.ASSETS = { fetch: async () => new Response('<html></html>') };
  await homePage(home);
  const initialHome = JSON.parse(written.get('#qdpInitialEvents'));
  checkExport(initialHome.events[0]);
  assert.equal(written.get('#eventStack').includes(meta.sourceNotice), false);
  renderEventPage(context('/?event=' + original.eventId), new Response('<html></html>'),
    { status: 200, event: original }, original.eventId);
  const initialEvent = JSON.parse(written.get('#qdpInitialEvent'));
  checkExport(initialEvent.event);
  assert.equal(written.get('#eventDetail').includes(meta.sourceNotice), false);
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const normalize = app.slice(app.indexOf('function stripQdpFooter('), app.indexOf('\nfunction readCachedPublicEvents('));
  const browser = vm.createContext({ Date, window: { QDPEventMetadata: meta },
    liveCalendar: globalThis.QDPLiveCalendar, eventIdOf: event => event.eventId });
  vm.runInContext(normalize, browser);
  for (const event of [initialHome.events[0], initialEvent.event]) {
    assert.equal(browser.normalizePublicEvents([event])[0].description, original.description);
    assert.equal(browser.stripQdpFooter(event.description), original.description);
  }
});
