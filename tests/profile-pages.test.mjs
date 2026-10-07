import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet as page } from '../functions/index.js';
import { renderProfileInfo, renderProfileEvents } from '../functions/profile-page.js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { shard } from '../functions/event-records.js';

const meta = globalThis.QDPProfileMetadata;
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const archiveSource = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
const eventLinksSource = fs.readFileSync(new URL('../event-linking.js', import.meta.url), 'utf8');
const profile = { id: 'PUBLIC-1', publicOk: true, name: 'Public & Profile', bio: 'Approved profile bio.',
  website: 'https://example.com/', instagram: 'https://www.instagram.com/public/', address: '123 Public St',
  related: [{ kind: 'artist', id: 'OTHER', name: 'Other Artist' }, { kind: 'artist', id: 'PRIVATE', name: 'Private Artist' }] };
const event = { public: true, eventId: 'EVENT-1', title: 'Public night', start: '2030-10-01T23:00:00-04:00',
  end: '2030-10-02T03:00:00-04:00', artistIds: ['PUBLIC-1'], venueId: 'PUBLIC-1',
  partyId: 'PUBLIC-1', collectiveIds: ['PUBLIC-1'], venue: 'Public Room', address: '123 Public St' };

function fixture(kind = 'artist', binding = 'QDP_ARCHIVE_KV', overrides = {}) {
  const manifest = { schema: 1, revision: 'one', partyPublicGate: true,
    artists: ['PUBLIC-1', 'OTHER'], venues: ['PUBLIC-1'], parties: ['PUBLIC-1'], collectives: ['PUBLIC-1'],
    eventIndexVersion: 1, eventIds: ['EVENT-1'], ...overrides };
  const counts = { artist: 4, venue: 2, party: 2, collective: 2 };
  const record = { revision: 'one', entries: { 'PUBLIC-1': { profile, events: [event,
    { ...event, eventId: 'PRIVATE-EVENT', public: false }, { ...event, eventId: 'CANCELLED', status: 'Cancelled' }] } } };
  const reads = [];
  const context = { request: new Request(`https://massive.example/?archive=${kind}&id=PUBLIC-1&noise=one`),
    env: {
      ASSETS: { fetch: async () => new Response(html, { headers: {
        'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex', ETag: 'old',
        'Content-Security-Policy': "default-src 'self'"
      } }) },
      [binding]: { get: async key => {
        reads.push(key);
        if (key === 'qdp-archive:v1:manifest') return manifest;
        assert.equal(key, `qdp-archive:v1:${kind}:${shard(profile.id, counts[kind])}`);
        return record;
      } }
    } };
  return { context, manifest, record, reads };
}

function recordRewriter() {
  const recorded = new Map();
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) handler.element({
        setInnerContent: (content, options) => { recorded.set(selector, content); recorded.set(`${selector}:options`, options); },
        setAttribute: (name, value) => recorded.set(`${selector}:${name}`, value),
        getAttribute: () => '', removeAttribute() {}
      });
      return response;
    }
  };
  return recorded;
}

for (const kind of Object.keys(meta.kinds)) {
  test(`${kind} HTML has public content and a distinct canonical before JavaScript loads`, async () => {
    const previous = { rewriter: globalThis.HTMLRewriter, fetch: globalThis.fetch };
    const recorded = recordRewriter();
    globalThis.fetch = () => { throw new Error('Prepared profiles must not call Google'); };
    try {
      const { context, reads } = fixture(kind);
      const response = await page(context);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-QDP-Profile'), 'PREPARED');
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
      assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'self'");
      assert.equal(response.headers.get('ETag'), null);
      assert.equal(recorded.get('title'), 'Public & Profile | Queer Dance Philly');
      assert.equal(recorded.get('link[rel="canonical"]:href'), meta.url(kind, profile.id));
      assert.equal(recorded.get('meta[property="og:url"]:content'), meta.url(kind, profile.id));
      assert.equal(recorded.get('meta[name="description"]:content'), profile.bio);
      const body = recorded.get('#archiveStack');
      assert.match(body, /Public &amp; Profile/);
      assert.match(body, /Approved profile bio/);
      assert.match(body, /Public night/);
      assert.match(body, new RegExp(`archive=${kind}&amp;id=PUBLIC-1&amp;event=EVENT-1`));
      assert.doesNotMatch(body, /Private Artist|PRIVATE-EVENT|CANCELLED/);
      if (kind === 'venue') assert.match(body, /<address>123 Public St<\/address>/);
      else assert.doesNotMatch(body, /<address>/);
      const initial = JSON.parse(recorded.get('#qdpInitialArchive'));
      assert.equal(initial.kind, kind);
      assert.deepEqual(initial.payload.events.map(item => item.eventId), ['EVENT-1']);
      assert.deepEqual(initial.payload.profile.related.map(item => item.id), ['OTHER']);
      assert.equal(reads.length, 2);
    } finally { globalThis.HTMLRewriter = previous.rewriter; globalThis.fetch = previous.fetch; }
  });
}

test('normalized profile HTML is cached and production binding uses the same prepared data', async () => {
  const previous = { caches: globalThis.caches, rewriter: globalThis.HTMLRewriter };
  const edge = new Map();
  globalThis.caches = { default: {
    match: async key => edge.get(key.url)?.clone(),
    put: async (key, response) => edge.set(key.url, response.clone())
  } };
  recordRewriter();
  try {
    const { context, reads } = fixture('artist', 'QDP_PUBLIC_FEED_KV');
    assert.equal((await page(context)).status, 200);
    context.request = new Request('https://massive.example/?noise=two&id=PUBLIC-1&archive=artist');
    assert.equal((await page(context)).headers.get('X-QDP-Profile'), 'PREPARED');
    assert.equal(reads.length, 2);
    assert.equal(edge.size, 2); // One API entry plus one HTML entry.
  } finally { globalThis.caches = previous.caches; globalThis.HTMLRewriter = previous.rewriter; }
});

test('removed or malformed profile URLs return 404; an unapproved party gate returns an uncached 503', async () => {
  const previous = { rewriter: globalThis.HTMLRewriter, fetch: globalThis.fetch };
  recordRewriter();
  globalThis.fetch = () => { throw new Error('Do not fall back for removed profiles or ungated parties'); };
  try {
    const missing = fixture('artist', 'QDP_ARCHIVE_KV', { artists: [] });
    const response = await page(missing.context);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(missing.reads.length, 1);
    missing.context.request = new Request('https://massive.example/?archive=artist&id=../private');
    assert.equal((await page(missing.context)).status, 404);
    assert.equal(missing.reads.length, 1);
    const party = fixture('party', 'QDP_ARCHIVE_KV', { partyPublicGate: false });
    const waiting = await page(party.context);
    assert.equal(waiting.status, 503);
    assert.equal(waiting.headers.get('Cache-Control'), 'no-store');
    assert.equal(party.reads.length, 1);
  } finally { globalThis.HTMLRewriter = previous.rewriter; globalThis.fetch = previous.fetch; }
});

test('profile markup escapes text, rejects unsafe links, and groups local dates across years', () => {
  const info = renderProfileInfo('artist', { ...profile, name: '<img src=x onerror=alert(1)>',
    bio: '</section><script>bad()</script>', website: 'javascript:alert(1)', instagram: '' }, 'https://massive.example');
  assert.doesNotMatch(info, /<script>|<img|javascript:|<address>/);
  assert.match(info, /&lt;script&gt;/);
  const result = renderProfileEvents('venue', profile, [event,
    { ...event, eventId: 'NEXT-YEAR', start: '2031-01-12T00:30:00Z', end: '' },
    { ...event, eventId: 'PAST', start: '2024-01-01T23:00:00-05:00', end: '' }],
  'https://massive.example', Date.parse('2029-10-01T00:00:00Z'));
  assert.match(result, /Upcoming/);
  assert.match(result, /Older/);
  assert.match(result, /archive-year-heading">2030/);
  assert.match(result, /archive-year-heading">2031/);
  assert.match(result, /archive-year-heading">2024/);
  assert.match(result, /datetime="2031-01-12T00:30:00Z">11th/); // Philadelphia is still January 11.
  assert.ok(result.indexOf('EVENT-1') < result.indexOf('NEXT-YEAR'));
  assert.doesNotMatch(result, /class="event-venue"|class="event-address"/);
});

test('sitemap reads one manifest, includes all four canonical profile types, and honors public gates', async () => {
  const { context, reads } = fixture('artist', 'QDP_PUBLIC_FEED_KV', {
    artists: ['PUBLIC-1', 'PUBLIC-1', '../bad', ''], parties: ['PRIVATE-PARTY'], partyPublicGate: false,
    eventIds: ['EVENT-1', 'WITHDRAWN'], excludedEventIds: ['WITHDRAWN']
  });
  context.env.QDP_CANONICAL_ORIGIN = 'https://canonical.example';
  const xml = await (await sitemap(context)).text();
  assert.equal(reads.length, 1);
  assert.equal((xml.match(/<loc>/g) || []).length, 5); // Home, event, and three approved profile kinds.
  for (const kind of ['artist', 'venue', 'collective']) assert.match(xml,
    new RegExp(`https://canonical.example/\\?archive=${kind}&amp;id=PUBLIC-1`));
  assert.doesNotMatch(xml, /PRIVATE-PARTY|WITHDRAWN|bad|massive.example/);
  const allowed = fixture();
  assert.match(await (await sitemap(allowed.context)).text(), /archive=party&amp;id=PUBLIC-1/);
});

test('browser uses embedded profile data once and a malformed payload still fetches the API', async () => {
  const seed = archiveSource.slice(archiveSource.indexOf('  try {'), archiveSource.indexOf('  const directoryViews'));
  const loader = archiveSource.slice(archiveSource.indexOf('  function endpoint('), archiveSource.indexOf('  function directorySortName('));
  for (const valid of [true, false]) {
    const requests = [];
    const initial = { status: 200, kind: 'artist', id: 'PUBLIC-1', payload: { profile: { ...profile,
      id: valid ? 'PUBLIC-1' : 'MISMATCH' }, events: [event] } };
    const context = vm.createContext({ Map, URL, Date, Object, Promise, console,
      location: { origin: 'https://massive.example' },
      document: { getElementById: () => ({ content: { textContent: JSON.stringify(initial) } }) },
      fetch: async url => { requests.push(url); return Response.json({ profile, events: [event] }); }
    });
    vm.runInContext(`const cache = new Map(); const CLIENT_CACHE_MS = 60000;
      const profileViews = { artist: 'artists', venue: 'venues', party: 'parties', collective: 'collectives' };
      ${seed}\n${loader}`, context);
    assert.equal((await context.load('artist', 'PUBLIC-1')).profile.id, 'PUBLIC-1');
    await context.load('artist', 'PUBLIC-1');
    assert.equal(requests.length, valid ? 0 : 1);
  }
});

test('closing an event restores the current profile metadata; leaving the profile restores home metadata', () => {
  const elements = new Map();
  const initial = JSON.stringify({ status: 200, kind: 'artist', id: profile.id, payload: { profile, events: [event] } });
  const document = {
    title: meta.title(profile),
    querySelector: selector => elements.get(selector),
    getElementById: id => id === 'qdpInitialArchive' ? { content: { textContent: initial } } : elements.get(id),
    createElement: () => ({ remove() { elements.delete(this.id); } }),
    head: { appendChild: item => elements.set(item.id, item) }
  };
  for (const [selector, content] of meta.tags('artist', profile)) elements.set(selector, { content });
  const canonical = { href: meta.url('artist', profile.id), setAttribute(name, value) { this[name] = value; } };
  elements.set('link[rel="canonical"]', canonical);
  const window = { QDPEventMetadata: globalThis.QDPEventMetadata, QDPProfileMetadata: meta };
  const restore = archiveSource.slice(archiveSource.indexOf('    restoreMetadata() {'), archiveSource.indexOf('    baseUrl() {'));
  const context = vm.createContext({ window, document, Map, Date, Promise, console,
    routeParams: () => ({ view: 'artist', id: profile.id }),
    fetch() { throw new Error('Metadata restoration must not request data'); }
  });
  vm.runInContext(`window.QDPArchive = { active: true, profile: { kind: 'artist', person: ${JSON.stringify(profile)} }, ${restore} };`, context);
  vm.runInContext(eventLinksSource, context);
  window.QDPEventLinks.apply(event);
  assert.equal(canonical.href, globalThis.QDPEventMetadata.url(event.eventId));
  assert.ok(elements.has('qdpEventStructuredData'));
  window.QDPEventLinks.clear(); // The event query may still be present during the close handler.
  assert.equal(document.title, meta.title(profile));
  assert.equal(canonical.href, meta.url('artist', profile.id));
  assert.equal(elements.get('meta[name="description"]').content, profile.bio);
  assert.equal(elements.get('meta[name="twitter:description"]').content, profile.bio);
  assert.equal(elements.has('qdpEventStructuredData'), false);
  window.QDPArchive.active = false;
  window.QDPArchive.profile = null;
  window.QDPEventLinks.clear();
  assert.equal(canonical.href, meta.origin + '/');
  assert.match(elements.get('meta[name="description"]').content, /^Find queer dance parties/);
});
