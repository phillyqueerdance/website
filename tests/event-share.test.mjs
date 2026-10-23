import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { shareImageSvg, dataImage } from '../functions/share-image-layout.js';
import { fetchFlyer, imageBytes, publicImageUrl } from '../functions/share-image-source.js';
import { shareImageHandler } from '../functions/share-image-handler.js';
import { shareArtifact } from '../functions/share-image-artifact.js';
import { shard } from '../functions/event-records.js';

const meta = globalThis.QDPEventMetadata;
const event = { eventId: 'DANCE-1', public: true, title: 'A title excluded from the image',
  description: 'A description excluded from the image', start: '2026-10-18T01:00:00Z',
  end: '2026-10-18T05:00:00Z', flyerUrl: 'https://images.example/flyer.png',
  explicitQueer: true, queerArtist: true, transArtist: true, artistIds: [], collectiveIds: [] };
const source = { frame: 'data:image/png;base64,FRAME', flyer: 'data:image/png;base64,FLYER',
  background: 'data:image/jpeg;base64,BACKGROUND' };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function fixture(overrides = {}, published = event) {
  const manifest = { schema: 1, revision: 'one', eventIndexVersion: 1, eventShards: 8,
    eventIds: [published.eventId], excludedEventIds: [], artists: [], venues: [],
    parties: [], collectives: [], ...overrides };
  const records = new Map([
    ['qdp-archive:v1:manifest', manifest],
    [`qdp-archive:v1:event:${shard(published.eventId, 8)}`,
      { revision: 'one', entries: { [published.eventId]: published } }]
  ]);
  return { manifest, context: { request: new Request(meta.shareImage(published, 'https://preview.example')),
    env: { QDP_ARCHIVE_KV: { get: async key => records.get(key) || null },
      ASSETS: { fetch: async () => new Response('generic', { headers: { 'Content-Type': 'image/jpeg' } }) } } } };
}

test('the share image contains the full flyer, frame, local date and flags without popup text or navigation', () => {
  const svg = shareImageSvg(event, source);
  assert.match(svg, /Saturday, October 17, 2026/);
  for (const image of Object.values(source)) assert.ok(svg.includes(image));
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(svg, /fill="#922185"/);
  assert.match(svg, /clip-path="url\(#pride\)"/);
  assert.match(svg, /clip-path="url\(#trans\)"/);
  assert.doesNotMatch(svg, /A title excluded|A description excluded|Back|See More/);
  const regular = shareImageSvg({ ...event, explicitQueer: false, queerArtist: false, transArtist: false }, source);
  assert.match(regular, /fill="#fa2b5a"/);
  assert.doesNotMatch(regular, /fill="#922185"|<g clip-path="url\(#(?:pride|trans)\)"/);
  assert.equal(dataImage({ bytes: png, type: 'image/png' }), 'data:image/png;base64,iVBORw0KGgo=');
});

test('event link thumbnails use a versioned image endpoint that changes when its visible content changes', () => {
  const first = meta.shareImage(event, 'https://preview.example');
  const url = new URL(first);
  assert.equal(url.origin, 'https://preview.example');
  assert.equal(url.pathname, '/api/event-share-image');
  assert.equal(url.searchParams.get('event'), event.eventId);
  for (const change of [{ flyerUrl: 'https://images.example/new.jpg' }, { start: '2026-11-01T03:00:00Z' },
    { explicitQueer: false }, { queerArtist: false }, { transArtist: false }, { partyId: 'MELT-001' }]) {
    assert.notEqual(meta.shareImage({ ...event, ...change }, url.origin), first);
  }
  assert.equal(meta.shareImage({ ...event, title: 'New title' }, url.origin), first);
  assert.equal(meta.shareImage({ ...event, flyerUrl: '' }, url.origin), 'https://preview.example/qdp-share-card.jpg');
  assert.equal(new URL(meta.shareImage({ ...event, eventId: 'SAZÓN-1' })).searchParams.get('event'), 'SAZÓN-1');
});

test('opening a popup in the browser keeps the generated thumbnail and restores home metadata on close', () => {
  const elements = new Map([
    ['meta[property="og:image"]', { content: 'https://preview.example/qdp-share-card.jpg' }],
    ['meta[name="twitter:image"]', { content: 'https://preview.example/qdp-share-card.jpg' }],
    ['meta[property="og:image:width"]', { content: '1200' }],
    ['meta[property="og:image:height"]', { content: '1200' }],
    ['meta[property="og:image:type"]', { content: 'image/jpeg' }]
  ]);
  const window = { QDPEventMetadata: meta, location: { origin: 'https://preview.example' } };
  const document = { title: 'Queer Dance Philly', querySelector: selector => elements.get(selector),
    getElementById: () => null };
  const context = vm.createContext({ window, document, Map, Date, Promise, console });
  vm.runInContext(fs.readFileSync(new URL('../event-linking.js', import.meta.url), 'utf8'), context);
  window.QDPEventLinks.apply(event);
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
    assert.equal(elements.get(selector).content, meta.shareImage(event, window.location.origin));
  }
  assert.equal(elements.get('meta[property="og:image:width"]').content, '');
  assert.equal(elements.get('meta[property="og:image:height"]').content, '');
  assert.equal(elements.get('meta[property="og:image:type"]').content, '');
  window.QDPEventLinks.clear();
  assert.equal(elements.get('meta[property="og:image"]') .content, 'https://preview.example/qdp-share-card.jpg');
  assert.equal(elements.get('meta[property="og:image:width"]').content, '1200');
});

test('flyer loading follows safe public redirects and rejects invalid sources, nonimages and oversized bodies', async () => {
  for (const url of ['http://images.example/a.jpg', 'https://localhost/a.jpg', 'https://10.0.0.1/a.jpg',
    'https://[::1]/a.jpg', 'https://secret.internal/a.jpg', 'https://a:b@images.example/a.jpg']) {
    assert.throws(() => publicImageUrl(url));
  }
  assert.equal(publicImageUrl('https://lh3.googleusercontent.com/d/ABC-123=w1600').pathname, '/d/ABC-123=w1000');
  const requests = [];
  const image = await fetchFlyer(event.flyerUrl, async url => {
    requests.push(url);
    return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: '/final.png' } })
      : new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.deepEqual(requests, ['https://images.example/flyer.png', 'https://images.example/final.png']);
  assert.deepEqual(image.bytes, png);
  await assert.rejects(fetchFlyer(event.flyerUrl, async () => new Response(null, {
    status: 302, headers: { Location: 'https://localhost/private.png' } })));
  for (const response of [new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('', { headers: { 'Content-Type': 'image/png' } }),
    new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(9 * 1024 * 1024) } })]) {
    await assert.rejects(imageBytes(response));
  }
});

test('prepared files are served without rendering and cached images remain subject to publication checks', async () => {
  const previousCaches = globalThis.caches;
  const cache = new Map();
  let fetched = 0;
  globalThis.caches = { default: { match: async key => cache.get(key.url)?.clone(),
    put: async (key, response) => cache.set(key.url, response.clone()) } };
  const artifact = await shareArtifact(event);
  const handle = shareImageHandler(async url => {
    fetched++;
    assert.equal(url, artifact.url);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  try {
    const { context } = fixture();
    const first = await handle(context);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), png);
    assert.match(first.headers.get('Cache-Control'), /max-age=(?:5\d|60)$/);
    assert.equal((await handle(context)).status, 200);
    assert.equal(fetched, 1);
    // Remove only the event/manifest lookup caches, keeping the rendered image.
    for (const key of cache.keys()) if (!key.includes('/api/event-share-image?')) cache.delete(key);
    const withdrawn = fixture({ excludedEventIds: [event.eventId] });
    assert.equal((await handle(withdrawn.context)).status, 404);
    assert.equal(fetched, 1);
    const invalid = fixture().context;
    invalid.request = new Request('https://preview.example/api/event-share-image?url=https://images.example/arbitrary.png');
    assert.equal((await handle(invalid)).status, 400);
  } finally { globalThis.caches = previousCaches; }
});

test('missing, corrupt, oversized, and temporarily unavailable saved images use the original flyer', async () => {
  for (const fetcher of [async () => new Response('missing', { status: 404 }),
    async () => { throw new Error('Storage unavailable'); },
    async () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    async () => new Response('corrupt', { headers: { 'Content-Type': 'image/png' } }),
    async () => new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': '5000000' } })]) {
    const response = await shareImageHandler(fetcher)(fixture().context);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), event.flyerUrl);
    assert.equal(response.headers.get('X-QDP-Share-Image'), 'pending');
    assert.match(response.headers.get('Cache-Control'), /max-age=60/);
  }
});

test('artifact names agree across Unicode IDs, local month boundaries, and every visible input', async () => {
  const first = await shareArtifact({ ...event, eventId: 'SAZÓN-1', start: '2026-11-01T02:00:00Z' });
  assert.equal(first.tag, 'qdp-share-images-2026-10');
  assert.match(first.name, /^event-[a-f0-9]{64}\.png$/);
  const before = await shareArtifact(event);
  for (const change of [{ flyerUrl: 'https://images.example/new.jpg' }, { start: '2026-11-01T03:00:00Z' },
    { explicitQueer: false }, { queerArtist: false }, { transArtist: false }, { partyId: 'MELT-001' },
    { eventId: 'ANOTHER-EVENT' }]) assert.notEqual((await shareArtifact({ ...event, ...change })).name, before.name);
  assert.equal((await shareArtifact({ ...event, title: 'A different title' })).name, before.name);
});
