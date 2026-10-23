import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolveEvent, cleanIndexedEvent, shard, validEventId } from '../functions/event-records.js';
import { renderEventDetail, renderEventPage } from '../functions/event-page.js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { onRequestGet as relations } from '../functions/api/event-relations.js';
import { onRequestGet as eventApi } from '../functions/api/event.js';

const meta = globalThis.QDPEventMetadata;
const event = { eventId: 'PAST-1', public: true, title: '🏳️‍🌈 Dance & Go',
  start: '2024-10-01T22:00:00-04:00', end: '2024-10-02T02:00:00-04:00',
  venue: 'The Room', venueId: 'ROOM', address: '123 Market St, Philadelphia, PA 19106',
  description: 'Doors at 10.', artistIds: ['ALPHA'], partyId: 'NIGHT', collectiveIds: ['CREW'],
  related: [{ kind: 'artist', id: 'ALPHA', name: 'Alpha' }, { kind: 'venue', id: 'ROOM', name: 'The Room' }] };
function fixture(overrides = {}, indexedEvent = event) {
  const manifest = { schema: 1, revision: 'one', eventIndexVersion: 1, eventShards: 8,
    eventIds: [indexedEvent.eventId], excludedEventIds: [], partyPublicGate: true,
    artists: ['ALPHA'], venues: ['ROOM'], parties: ['NIGHT'], collectives: ['CREW'], ...overrides };
  const reads = [];
  const values = new Map([
    ['qdp-archive:v1:manifest', manifest],
    [`qdp-archive:v1:event:${shard(indexedEvent.eventId, 8)}`, { revision: 'one', entries: { [indexedEvent.eventId]: indexedEvent } }]
  ]);
  const context = { request: new Request(`https://massive.example/?event=${encodeURIComponent(indexedEvent.eventId)}`),
    env: { QDP_ARCHIVE_KV: { get: async key => { reads.push(key); return values.get(key) || null; } } } };
  return { manifest, reads, values, context };
}

test('a past event resolves from two KV records and a warm normalized request uses no KV reads', async () => {
  const previous = globalThis.caches;
  const cache = new Map();
  globalThis.caches = { default: { match: async request => cache.get(request.url)?.clone(),
    put: async (request, response) => cache.set(request.url, response.clone()) } };
  try {
    const { context, reads } = fixture();
    const first = await resolveEvent(context, event.eventId);
    assert.equal(first.status, 200);
    assert.equal(first.indexed, true);
    assert.equal(first.event.start, event.start);
    assert.equal(reads.length, 2);
    context.request = new Request(`https://massive.example/?archive=artist&id=ALPHA&event=${event.eventId}`);
    assert.equal((await resolveEvent(context, event.eventId)).event.eventId, event.eventId);
    assert.equal(reads.length, 2);
  } finally { globalThis.caches = previous; }
});

test('withdrawn events cannot reappear from a stale live feed', async () => {
  const { context, reads } = fixture({ eventIds: [], excludedEventIds: [event.eventId] });
  const result = await resolveEvent(context, event.eventId);
  assert.equal(result.status, 404);
  assert.equal(result.event, undefined);
  assert.equal(reads.length, 1);
});

test('a newly published current event resolves before the next archive publication', async () => {
  const { context, values } = fixture({ eventIds: [] });
  values.set('qdp-live:v1:feed', { schema: 1, publishedAt: new Date().toISOString(),
    payload: { events: [{ ...event, start: '2099-10-01T22:00:00-04:00', end: '' }] } });
  const result = await resolveEvent(context, event.eventId);
  assert.equal(result.status, 200);
  assert.equal(result.indexed, false);
});

test('a known missing event returns 404 and propagation errors return 503 rather than a soft 404', async () => {
  const { context, values } = fixture({ eventIds: [] });
  values.set('qdp-live:v1:feed', { schema: 1, publishedAt: new Date().toISOString(), payload: { events: [] } });
  assert.equal((await resolveEvent(context, event.eventId)).status, 404);
  values.get('qdp-archive:v1:manifest').eventIds = [event.eventId];
  values.get(`qdp-archive:v1:event:${shard(event.eventId, 8)}`).revision = 'old';
  assert.equal((await resolveEvent(context, event.eventId)).status, 503);
  assert.equal((await resolveEvent(context, '../private')).status, 400);
});

test('an old archive snapshot provides permanent links during publisher migration', async () => {
  const { context, manifest, values } = fixture({ eventIndexVersion: undefined, months: ['2024-10'] });
  values.set('qdp-live:v1:feed', { schema: 1, publishedAt: new Date().toISOString(), payload: { events: [] } });
  for (let i = 0; i < 4; i++) values.set(`qdp-archive:v1:month:${i}`, {
    revision: manifest.revision, entries: i === 0 ? { '2024-10': { events: [{ ...event, related: undefined }] } } : {}
  });
  const result = await resolveEvent(context, event.eventId);
  assert.equal(result.status, 200);
  assert.equal(result.indexed, false);
  assert.equal(result.event.related, undefined); // Old records still load related profiles separately.
});

test('private references and their address never reach event HTML or Event markup', () => {
  const { manifest } = fixture({ venues: [], parties: [] });
  const cleaned = cleanIndexedEvent({ ...event, artistIds: ['ALPHA', 'PRIVATE'],
    related: [...event.related, { kind: 'artist', id: 'PRIVATE', name: 'Private Person' },
      { kind: 'party', id: 'NIGHT', name: 'Private Party' }] }, manifest);
  assert.equal(cleaned.venue, 'Location not disclosed');
  assert.equal(cleaned.address, '');
  assert.deepEqual(cleaned.artistIds, ['ALPHA']);
  assert.equal(cleaned.partyId, '');
  assert.deepEqual(cleaned.related.map(item => item.name), ['Alpha']);
  assert.equal(meta.schema(cleaned), null);
  assert.doesNotMatch(renderEventDetail(cleaned, 'https://massive.example/?event=PAST-1'),
    /123 Market|Private Person|Private Party|google.com\/maps/);
});

test('Event markup has public required fields, correct cross-midnight dates, and safe serialization', () => {
  const data = meta.schema(event);
  assert.equal(data['@type'], 'Event');
  assert.equal(data.name, 'Dance & Go');
  assert.equal(data.url, 'https://queerdancephilly.com/?event=PAST-1');
  assert.equal(data.startDate, event.start);
  assert.equal(data.endDate, event.end);
  assert.equal(data.location.address['@type'], 'PostalAddress');
  assert.equal(data.location.address.streetAddress, event.address);
  assert.equal(meta.schema({ ...event, address: '' }), null);
  assert.equal(meta.schema({ ...event, venue: 'Secret location' }), null);
  assert.equal(meta.image({ flyerUrl: 'javascript:alert(1)' }), '');
  assert.equal(meta.image({ flyerUrl: 'https://drive.google.com/file/d/ABC-123/view' }),
    'https://lh3.googleusercontent.com/d/ABC-123=w1600');
  assert.doesNotMatch(meta.serialize({ description: '</script><script>alert(1)</script>' }), /</);
});

test('server-rendered event HTML remains readable without JavaScript and safely links back to its archive', () => {
  const html = renderEventDetail({ ...event, title: '<Dance & Go>', description: '<script>evil</script>' },
    'https://massive.example/?archive=artist&id=ALPHA&event=PAST-1');
  assert.match(html, /2024/);
  assert.match(html, /<h2 id="eventDetailTitle">&lt;Dance &amp; Go&gt;<\/h2>/);
  assert.match(html, /datetime="2024-10-01T22:00:00-04:00"/);
  assert.match(html, /123 Market St/);
  assert.match(html, /href="https:\/\/massive.example\/\?archive=artist&amp;id=ALPHA"/);
  assert.doesNotMatch(html, /<script>evil/);
});

test('the event page writes event metadata and JSON-LD before scripts load and preserves preview noindex', async () => {
  const previous = globalThis.HTMLRewriter;
  const recorded = new Map();
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) handler.element({
        setInnerContent: content => recorded.set(selector, content),
        setAttribute: (name, value) => recorded.set(`${selector}:${name}`, value),
        removeAttribute() {}, remove() {}, append: content => recorded.set(`${selector}:append`, content)
      });
      return response;
    }
  };
  try {
    const { context } = fixture();
    const response = renderEventPage(context, new Response('<html></html>', { headers: {
      'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'self'", ETag: 'old'
    } }), { status: 200, event, indexed: true }, event.eventId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'self'");
    assert.equal(response.headers.get('ETag'), null);
    assert.equal(recorded.get('link[rel="canonical"]:href'), meta.url(event.eventId));
    assert.equal(recorded.get('meta[name="twitter:description"]:content'), meta.description(event));
    assert.equal(recorded.get('meta[property="og:image"]:content'), 'https://massive.example/qdp-share-card.jpg');
    const withFlyer = { ...event, flyerUrl: 'https://images.example/flyer.jpg' };
    renderEventPage(context, new Response('<html></html>'), { status: 200, event: withFlyer }, event.eventId);
    assert.equal(recorded.get('meta[property="og:image"]:content'), meta.shareImage(withFlyer, 'https://massive.example'));
    assert.equal(recorded.get('meta[name="twitter:image"]:content'), meta.shareImage(withFlyer, 'https://massive.example'));
    assert.equal(recorded.get('meta[property="og:image:type"]:content'), 'image/png');
    assert.equal(recorded.get('meta[property="og:image:width"]:content'), '900');
    assert.equal(recorded.get('meta[property="og:image:height"]:content'), '1067');
    assert.match(recorded.get('#eventDetail'), /Dance &amp; Go/);
    assert.match(recorded.get('head:append'), /"@type":"Event"/);
    assert.equal(JSON.parse(recorded.get('#qdpInitialEvent')).event.eventId, event.eventId);
    const missing = renderEventPage(context, new Response('<html></html>'), { status: 404, error: 'Event unavailable.' }, 'MISSING');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('X-Robots-Tag'), 'noindex');
  } finally { globalThis.HTMLRewriter = previous; }
});

test('sitemap contains unique canonical event URLs and excludes invalid or withdrawn IDs', async () => {
  const { context } = fixture({ eventIds: ['PAST-1', 'PAST-1', 'PRIVATE', '../bad'], excludedEventIds: ['PRIVATE'] });
  const response = await sitemap(context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/xml/);
  const xml = await response.text();
  assert.equal((xml.match(/<loc>/g) || []).length, 9);
  assert.match(xml, /https:\/\/queerdancephilly.com\/\?event=PAST-1/);
  assert.doesNotMatch(xml, /PRIVATE|bad|massive.example/);
});

test('indexed event relations use two reads instead of scanning every profile shard', async () => {
  const { context, reads } = fixture();
  context.request = new Request('https://massive.example/api/event-relations?event=PAST-1');
  const response = await relations(context);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).related, event.related);
  assert.equal(reads.length, 2);
});

test('event IDs accept Unicode letters and numbers while rejecting unsafe characters and oversized IDs', () => {
  for (const id of ['SAZÓNP-102926', 'CAFÉ-102926', '東京-102926', 'MELT-081526', 'EVENT_1', 'A'.repeat(100)]) {
    assert.equal(validEventId(id), true, id);
  }
  for (const id of ['', '../private', 'E/1', 'E?x=1', 'E#1', 'E 1', 'E\n', '<script>',
    'SAZ%C3%93NP-102926', '🎉-102926', 'A'.repeat(101), null, 123]) {
    assert.equal(validEventId(id), false, String(id));
  }
});

test('Sazón IDs resolve unchanged through the event API, related links, and canonical sitemap URLs', async () => {
  const sazon = { ...event, eventId: 'SAZÓNP-102926', title: 'Sazón presents: Soy Emo',
    partyId: 'SAZON-001', related: [{ kind: 'party', id: 'SAZON-001', name: 'Sazón' }] };
  const { context } = fixture({ parties: ['SAZON-001'] }, sazon);
  const url = new URL('/api/event', context.request.url);
  url.searchParams.set('event', sazon.eventId);
  context.request = new Request(url);
  const eventResponse = await eventApi(context);
  assert.equal(eventResponse.status, 200);
  const returned = (await eventResponse.json()).event;
  assert.equal(returned.eventId, sazon.eventId);
  assert.equal(returned.title, sazon.title);
  assert.equal(returned.partyId, 'SAZON-001');

  url.pathname = '/api/event-relations';
  context.request = new Request(url);
  const relatedResponse = await relations(context);
  assert.equal(relatedResponse.status, 200);
  assert.deepEqual((await relatedResponse.json()).related, sazon.related);

  const sitemapResponse = await sitemap(context);
  assert.equal(sitemapResponse.status, 200);
  assert.match(await sitemapResponse.text(), /\?event=SAZ%C3%93NP-102926/);
  assert.equal(new URL(meta.url(returned.eventId)).searchParams.get('event'), sazon.eventId);
  assert.match(renderEventDetail(returned, meta.url(returned.eventId)), /Sazón presents: Soy Emo/);
});

test('an accented ID in the live feed resolves before its archive record is published', async () => {
  const sazon = { ...event, eventId: 'SAZÓNP-102926',
    start: '2099-10-29T22:00:00-04:00', end: '' };
  const { context, values } = fixture({ eventIds: [] }, sazon);
  values.set('qdp-live:v1:feed', { schema: 1, publishedAt: new Date().toISOString(),
    payload: { events: [sazon] } });
  const result = await resolveEvent(context, sazon.eventId);
  assert.equal(result.status, 200);
  assert.equal(result.event.eventId, sazon.eventId);
  assert.equal(result.indexed, false);
});

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const navigation = app.slice(app.indexOf('async function syncEventFromUrl('),
  app.indexOf('\nwindow.addEventListener("popstate"', app.indexOf('async function syncEventFromUrl(')));
function navigationContext(get) {
  const opened = [], errors = [];
  const context = vm.createContext({ URLSearchParams, Map, freshEventsLoaded: true,
    window: { location: { search: '?event=PAST-1' }, QDPEventLinks: { get } },
    posterPages: [], activeEventId: '', eventDetail: { hidden: true }, eventCardsById: new Map(),
    requestedEventId: () => new URLSearchParams(context.window.location.search).get('event') || '',
    hideEventDetail() {}, scrollToPage() {}, history: { state: null, replaceState() { throw new Error('Event URL was removed'); } },
    openEventDetail: value => opened.push(value.eventId), showEventLookupError: error => errors.push(error.status),
    eventIdOf: value => value.eventId
  });
  vm.runInContext(`let eventLookupSerial = 0;\n${navigation}`, context);
  return { context, opened, errors };
}

test('past-event navigation resolves outside the current calendar without stripping its URL', async () => {
  const { context, opened } = navigationContext(async () => event);
  await context.syncEventFromUrl();
  assert.deepEqual(opened, ['PAST-1']);
  assert.equal(context.window.location.search, '?event=PAST-1');
});

test('a slow event response cannot reopen the popup after Back', async () => {
  let finish;
  const { context, opened } = navigationContext(() => new Promise(resolve => { finish = resolve; }));
  const pending = context.syncEventFromUrl();
  context.window.location.search = '';
  await context.syncEventFromUrl();
  finish(event);
  await pending;
  assert.deepEqual(opened, []);
});

test('a failed event lookup leaves the permalink intact and shows an error', async () => {
  const { context, errors } = navigationContext(async () => { throw Object.assign(new Error('missing'), { status: 404 }); });
  await context.syncEventFromUrl();
  assert.deepEqual(errors, [404]);
  assert.equal(context.window.location.search, '?event=PAST-1');
});
