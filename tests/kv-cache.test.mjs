import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as archive } from '../functions/api/archive.js';
import { onRequestGet as live } from '../functions/api/events.js';
import { onRequestGet as relations } from '../functions/api/event-relations.js';
import { onRequestGet as eventApi } from '../functions/api/event.js';
import { resolveEvent, publicSitemapEntries, shard } from '../functions/event-records.js';
import { profilePage } from '../functions/profile-page.js';
import { onRequestGet as home } from '../functions/index.js';

const prefix = 'qdp-archive:v1:';
function setup(t) {
  const previous = { caches: globalThis.caches, fetch: globalThis.fetch,
    now: Date.now, rewriter: globalThis.HTMLRewriter };
  let now = previous.now();
  Date.now = () => now;
  const edge = new Map();
  globalThis.caches = { default: {
    match: async key => edge.get(key.url)?.clone(),
    put: async (key, response) => edge.set(key.url, response.clone())
  } };
  globalThis.fetch = () => { throw new Error('Unexpected live fallback'); };
  globalThis.HTMLRewriter = class {
    on() { return this; }
    transform(response) { return response; }
  };
  t.after(() => {
    globalThis.caches = previous.caches; globalThis.fetch = previous.fetch;
    Date.now = previous.now; globalThis.HTMLRewriter = previous.rewriter;
  });
  const profiles = ['A', 'E'].map(id => ({ id, name: id, bio: 'Public bio', publicOk: true }));
  const event = id => ({ eventId: id, public: true, title: id, start: '2099-10-01T20:00:00-04:00',
    artistIds: ['A'], venueId: 'ROOM', venue: 'Public Room', address: 'Public address', partyId: 'NIGHT',
    related: [{ kind: 'artist', id: 'A', name: 'A' }, { kind: 'venue', id: 'ROOM', name: 'Public Room' },
      { kind: 'party', id: 'NIGHT', name: 'Public Night' }] });
  const manifest = { schema: 1, revision: 'global-one', recordIndexVersion: 1,
    recordRevisions: { artists: 'directory-one', 'artist:1': 'artists-one', 'event:4': 'events-one' },
    artists: ['A', 'E'], venues: ['ROOM'], parties: ['NIGHT'], collectives: [], months: [],
    partyPublicGate: true, eventIndexVersion: 1, eventShards: 8, eventIds: ['E1', 'E9'], excludedEventIds: [] };
  assert.equal(shard('A', 4), shard('E', 4));
  assert.equal(shard('E1', 8), shard('E9', 8));
  const values = new Map([
    [prefix + 'manifest', manifest],
    [prefix + 'artists', { revision: 'directory-one', payload: { artists: profiles } }],
    [prefix + 'artist:1', { revision: 'artists-one', entries: Object.fromEntries(profiles.map(profile =>
      [profile.id, { profile, events: [{ ...event('E1'), artistIds: [profile.id] }] }])) }],
    [prefix + 'event:4', { revision: 'events-one', entries: { E1: event('E1'), E9: event('E9') } }],
    ['qdp-live:v1:feed', { schema: 1, publishedAt: new Date(now).toISOString(),
      payload: { events: [event('NEW')] } }]
  ]);
  const reads = [];
  const kv = { get: async key => {
    reads.push(key);
    await new Promise(resolve => setImmediate(resolve));
    return structuredClone(values.get(key) ?? null);
  } };
  const context = path => ({ request: new Request('https://qdp.example' + path), env: {
    QDP_PUBLIC_FEED_KV: kv, ASSETS: { fetch: async () => new Response('<html></html>') }
  } });
  return { edge, values, manifest, reads, context, advance: ms => { now += ms; } };
}

test('profile pages, event details, related links, and sitemap share manifest and record reads', async t => {
  const f = setup(t);
  assert.equal((await archive(f.context('/api/archive?resource=artist&id=A'))).status, 200);
  assert.equal((await archive(f.context('/api/archive?resource=artist&id=E'))).status, 200);
  assert.equal((await resolveEvent(f.context('/?event=E1'), 'E1')).status, 200);
  assert.equal((await resolveEvent(f.context('/?event=E9'), 'E9')).status, 200);
  assert.equal((await relations(f.context('/api/event-relations?event=E1'))).status, 200);
  assert.equal((await publicSitemapEntries(f.context('/sitemap.xml'))).events.length, 2);
  assert.deepEqual(f.reads, [prefix + 'manifest', prefix + 'artist:1', prefix + 'event:4']);
});

test('simultaneous cold requests coalesce identical KV reads', async t => {
  const f = setup(t);
  const responses = await Promise.all([
    archive(f.context('/api/archive?resource=artist&id=A')),
    archive(f.context('/api/archive?resource=artist&id=E')),
    relations(f.context('/api/event-relations?event=E1')),
    relations(f.context('/api/event-relations?event=E9')),
    publicSitemapEntries(f.context('/sitemap.xml'))
  ]);
  assert.ok(responses.slice(0, 4).every(response => response.status === 200));
  assert.equal(f.reads.length, 3);
  assert.equal(new Set(f.reads).size, 3);
});

test('homepage and calendar API reuse a live record without extending its 30-second lifetime', async t => {
  const f = setup(t);
  const first = await home(f.context('/'));
  assert.equal(first.headers.get('X-QDP-Initial-Events'), 'PREPARED');
  f.advance(29000);
  const api = await live(f.context('/api/events'));
  assert.equal(api.headers.get('Cache-Control'), 'public, max-age=1');
  f.values.get('qdp-live:v1:feed').payload.events[0].title = 'Updated';
  f.advance(2000);
  assert.equal((await (await live(f.context('/api/events'))).json()).events[0].title, 'Updated');
  assert.deepEqual(f.reads, ['qdp-live:v1:feed', 'qdp-live:v1:feed']);
});

test('profile HTML inherits an existing API deadline rather than adding 60 seconds', async t => {
  const f = setup(t);
  await archive(f.context('/api/archive?resource=artist&id=A'));
  f.advance(59000);
  const html = await profilePage(f.context('/?archive=artist&id=A'), new Response('<html></html>'), 'artist', 'A');
  assert.equal(html.headers.get('Cache-Control'), 'public, max-age=1');
  f.manifest.artists = ['E'];
  f.manifest.revision = 'global-two';
  f.advance(2000);
  const removed = await profilePage(f.context('/?archive=artist&id=A'), new Response('<html></html>'), 'artist', 'A');
  assert.equal(removed.status, 404);
  assert.equal(removed.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.reads.filter(key => key === prefix + 'artist:1').length, 1);
});

test('manifest refresh reuses unchanged groups while current venue, party, and withdrawal gates take effect', async t => {
  const f = setup(t);
  await relations(f.context('/api/event-relations?event=E1'));
  await eventApi(f.context('/api/event?event=E1'));
  f.advance(59000);
  const another = await eventApi(f.context('/api/event?event=E9'));
  assert.equal(another.headers.get('Cache-Control'), 'public, max-age=1');
  f.manifest.revision = 'global-two';
  f.manifest.venues = [];
  f.manifest.partyPublicGate = false;
  f.manifest.excludedEventIds = ['E9'];
  f.advance(2000);
  const response = await eventApi(f.context('/api/event?event=E1'));
  const { event } = await response.json();
  assert.equal(event.address, '');
  assert.equal(event.venue, 'Location not disclosed');
  assert.equal(event.partyId, '');
  assert.deepEqual(event.related.map(item => item.kind), ['artist']);
  assert.equal((await eventApi(f.context('/api/event?event=E9'))).status, 404);
  assert.deepEqual((await (await relations(f.context('/api/event-relations?event=E1'))).json()).related.map(item => item.kind), ['artist']);
  assert.equal(f.reads.filter(key => key === prefix + 'manifest').length, 2);
  assert.equal(f.reads.filter(key => key === prefix + 'event:4').length, 1);
});

test('changed groups use the new content version; propagation mismatch fails closed and can recover immediately', async t => {
  const f = setup(t);
  await eventApi(f.context('/api/event?event=E1'));
  f.advance(61000);
  f.manifest.revision = 'global-two';
  f.manifest.recordRevisions['event:4'] = 'events-two';
  assert.equal((await eventApi(f.context('/api/event?event=E1'))).status, 503);
  const record = f.values.get(prefix + 'event:4');
  record.revision = 'events-two'; record.entries.E1.title = 'Edited event';
  const response = await eventApi(f.context('/api/event?event=E1'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).event.title, 'Edited event');
  assert.equal(f.reads.filter(key => key === prefix + 'event:4').length, 3);
});

test('legacy global revisions still work and cannot reuse a record from a different snapshot', async t => {
  const f = setup(t);
  delete f.manifest.recordIndexVersion; delete f.manifest.recordRevisions;
  f.values.get(prefix + 'event:4').revision = f.manifest.revision;
  assert.equal((await eventApi(f.context('/api/event?event=E1'))).status, 200);
  f.advance(61000);
  f.manifest.revision = 'legacy-two';
  assert.equal((await eventApi(f.context('/api/event?event=E1'))).status, 503);
});

test('missing or stale live records are read once per request during the fallback chain', async t => {
  const f = setup(t);
  f.values.delete('qdp-live:v1:feed');
  let googleReads = 0;
  globalThis.fetch = async () => {
    googleReads++;
    return Response.json({ events: [{ eventId: 'NEW', title: 'New', start: '2099-10-01T20:00:00-04:00' }] });
  };
  assert.equal((await resolveEvent(f.context('/?event=NEW'), 'NEW')).status, 200);
  assert.equal(f.reads.filter(key => key === 'qdp-live:v1:feed').length, 1);
  assert.equal(googleReads, 1);
});

test('a failed shared read does not poison the next request', async t => {
  const f = setup(t);
  f.context('/').env.QDP_PUBLIC_FEED_KV.get = async () => { throw new Error('Temporary KV failure'); };
  assert.equal((await eventApi(f.context('/api/event?event=E1'))).status, 503);
  f.context('/').env.QDP_PUBLIC_FEED_KV.get = async key => structuredClone(f.values.get(key));
  assert.equal((await eventApi(f.context('/api/event?event=E1'))).status, 200);
});

test('cache write failures still serve valid public data', async t => {
  const f = setup(t);
  globalThis.caches.default.put = async () => { throw new Error('Cache unavailable'); };
  // Test the raw cache failure independently of the existing response-cache path.
  const { readArchiveManifest, withKvScope } = await import('../functions/kv-cache.js');
  assert.equal((await readArchiveManifest(withKvScope(f.context('/')), f.context('/').env.QDP_PUBLIC_FEED_KV)).revision, 'global-one');
});
