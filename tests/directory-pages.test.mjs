import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet as page } from '../functions/index.js';
import { renderDirectory } from '../functions/directory-page.js';

const meta = globalThis.QDPProfileMetadata;
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const archiveSource = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
const linksSource = fs.readFileSync(new URL('../event-linking.js', import.meta.url), 'utf8');
const descriptions = {
  home: "Queer Philadelphia's guide to finding the next move. Discover queer dance parties, LGBTQ+ nightlife, DJs, artists, venues, and more!",
  parties: "Discover queer dance parties in Philadelphia: when they're happening, who's playing them, and where they're going down.",
  venues: "Discover queer dance venues in Philadelphia: what's coming up, who's playing, and who's played before."
};
const titles = { parties: 'Queer Dance Philly | Parties', venues: 'Queer Dance Philly | Venues',
  collectives: 'Queer Dance Philly | Collectives' };
const items = [
  { id: 'BETA-1', name: 'The Beta', publicOk: true, address: '123 Public St' },
  { id: 'ALPHA-1', name: 'Alpha & Friends', publicOk: 'Yes', queerParty: true, queerVenue: true, queerCollective: true },
  { id: 'PRIVATE', name: 'Private entry', publicOk: false },
  { id: '../BAD', name: 'Invalid entry', publicOk: true }
];

function fixture(directory, { list = items, gate = true, preview = false } = {}) {
  const manifest = { schema: 1, revision: 'one', partyPublicGate: gate,
    artists: [], parties: ['BETA-1', 'ALPHA-1'], venues: ['BETA-1', 'ALPHA-1'], collectives: ['BETA-1', 'ALPHA-1'] };
  const reads = [];
  const context = {
    request: new Request(`https://preview.example/?archive=${directory}&noise=one`),
    env: {
      ASSETS: { fetch: async () => new Response(html, { headers: {
        'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'", ETag: 'old',
        ...(preview ? { 'X-Robots-Tag': 'noindex' } : {})
      } }) },
      QDP_PUBLIC_FEED_KV: { get: async key => {
        reads.push(key);
        if (key === 'qdp-archive:v1:manifest') return manifest;
        assert.equal(key, `qdp-archive:v1:${directory}`);
        return { revision: 'one', payload: { [directory]: list } };
      } }
    }
  };
  return { context, reads };
}

function rewriter() {
  const recorded = new Map();
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) handler.element({
        setInnerContent: (value, options) => { recorded.set(selector, value); recorded.set(`${selector}:options`, options); },
        getAttribute: () => '', setAttribute: (name, value) => recorded.set(`${selector}:${name}`, value),
        removeAttribute: name => recorded.set(`${selector}:remove:${name}`, true)
      });
      return response;
    }
  };
  return recorded;
}

for (const directory of Object.keys(titles)) {
  test(`${directory} serves the agreed title and public directory before JavaScript loads`, async () => {
    const old = { rewriter: globalThis.HTMLRewriter, fetch: globalThis.fetch };
    const recorded = rewriter();
    globalThis.fetch = () => { throw new Error('Published directories must not call Google'); };
    try {
      const { context, reads } = fixture(directory);
      const response = await page(context);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-QDP-Directory'), 'PREPARED');
      assert.equal(response.headers.get('X-Robots-Tag'), null);
      assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'self'");
      assert.equal(response.headers.get('ETag'), null);
      assert.equal(recorded.get('title'), titles[directory]);
      assert.equal(recorded.get('link[rel="canonical"]:href'), `https://queerdancephilly.com/?archive=${directory}`);
      assert.equal(recorded.get('meta[property="og:url"]:content'), `https://queerdancephilly.com/?archive=${directory}`);
      assert.equal(recorded.get('meta[name="description"]:content'), descriptions[directory] || descriptions.home);
      const body = recorded.get('#archiveStack');
      assert.ok(body.indexOf('Alpha &amp; Friends') < body.indexOf('The Beta'));
      assert.match(body, /archive-identity-card/);
      assert.match(body, new RegExp(`href="https://preview.example/\\?archive=${meta.directories[directory].kind}&amp;id=ALPHA-1"`));
      assert.doesNotMatch(body, /Private entry|Invalid entry|Discover queer|<h1|<script/);
      assert.equal(body.includes('123 Public St'), directory === 'venues');
      assert.equal(recorded.get('#archiveStack:options').html, true);
      assert.equal(recorded.get('#archiveViewport:remove:hidden'), true);
      assert.match(recorded.get('html:class'), /archive-open discover-open/);
      assert.match(recorded.get('body:class'), /archive-mode discover-open/);
      assert.equal(recorded.get('#discoverLink:aria-expanded'), 'true');
      assert.equal(recorded.get('#archiveVenueMap:remove:hidden') === true, directory === 'venues');
      const initial = JSON.parse(recorded.get('#qdpInitialArchive'));
      assert.equal(initial.kind, directory);
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.payload[directory].map(item => item.id), ['BETA-1', 'ALPHA-1']);
      assert.equal(reads.length, 2);
    } finally { globalThis.HTMLRewriter = old.rewriter; globalThis.fetch = old.fetch; }
  });
}

test('directory cache normalizes query noise and retains preview noindex and a custom canonical origin', async () => {
  const old = { rewriter: globalThis.HTMLRewriter, caches: globalThis.caches };
  rewriter();
  const entries = new Map();
  globalThis.caches = { default: {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, response) => entries.set(key.url, response.clone())
  } };
  try {
    const { context, reads } = fixture('venues', { preview: true });
    context.env.QDP_CANONICAL_ORIGIN = 'https://canonical.example';
    const recorded = rewriter();
    const first = await page(context);
    assert.equal(first.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(recorded.get('link[rel="canonical"]:href'), 'https://canonical.example/?archive=venues');
    context.request = new Request('https://preview.example/?noise=two&archive=venues&id=ignored');
    const second = await page(context);
    assert.equal(second.headers.get('X-QDP-Directory'), 'PREPARED');
    assert.equal(reads.length, 2);
    assert.ok([...entries.keys()].some(key => key.includes('/_qdp/directory-v1?kind=venues')));
    assert.ok(Number(second.headers.get('X-QDP-Cache-Until')) <= Number(first.headers.get('X-QDP-Cache-Until')));
  } finally { globalThis.HTMLRewriter = old.rewriter; globalThis.caches = old.caches; }
});

test('an unpublished party directory returns uncached 503 while a published empty directory remains readable', async () => {
  const old = { rewriter: globalThis.HTMLRewriter, fetch: globalThis.fetch };
  const recorded = rewriter();
  globalThis.fetch = () => { throw new Error('Never use an ungated party feed'); };
  try {
    const { context, reads } = fixture('parties', { gate: false });
    const response = await page(context);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(reads.length, 1);
    assert.doesNotMatch(recorded.get('#archiveStack'), /Alpha|Beta/);
    const empty = await page(fixture('parties', { list: [] }).context);
    assert.equal(empty.status, 200);
    assert.match(recorded.get('#archiveStack'), /No parties in the archive yet/);
  } finally { globalThis.HTMLRewriter = old.rewriter; globalThis.fetch = old.fetch; }
});

test('directory rendering matches alphabet rules, escapes fields, and preserves the Melt treatment', () => {
  const body = renderDirectory('parties', [
    { id: 'MELT-001', name: 'Melt', queerParty: true },
    { id: 'SAZON-001', name: 'Sazón' }, { id: '2NIGHT', name: '2 Nights' },
    { id: 'BETA-1', name: 'The Beta' }, { id: 'ESCAPED', name: '<Bad & Name>' }
  ], 'https://preview.example');
  assert.ok(body.indexOf('2 Nights') < body.indexOf('The Beta'));
  assert.ok(body.indexOf('The Beta') < body.indexOf('Melt'));
  assert.match(body, /data-letter="#"/);
  assert.match(body, /data-letter="S"/);
  assert.match(body, /archive-card melt archive-identity-card/);
  assert.match(body, /&lt;Bad &amp; Name&gt;/);
  assert.doesNotMatch(body, /<Bad/);
});

test('embedded directory data hydrates without a second request; malformed data still uses the API', async () => {
  const seed = archiveSource.slice(archiveSource.indexOf('  try {'), archiveSource.indexOf('  const directoryViews'));
  const loader = archiveSource.slice(archiveSource.indexOf('  function endpoint('), archiveSource.indexOf('  function directorySortName('));
  for (const directory of Object.keys(titles)) for (const valid of [true, false]) {
    const requests = [];
    const payload = { [directory]: valid ? items : 'not a directory' };
    const initial = { status: 200, kind: directory, id: '', payload };
    const context = vm.createContext({ Map, URL, Date, Object, Promise, console,
      location: { origin: 'https://preview.example' },
      document: { getElementById: () => ({ content: { textContent: JSON.stringify(initial) } }) },
      fetch: async url => { requests.push(url); return Response.json({ [directory]: items }); }
    });
    vm.runInContext(`const cache = new Map(); const CLIENT_CACHE_MS = 60000;
      const profileViews = { artist: 'artists', venue: 'venues', party: 'parties', collective: 'collectives' };
      ${seed}\n${loader}`, context);
    await context.load(directory, '');
    await context.load(directory, '');
    assert.equal(requests.length, valid ? 0 : 1);
  }
});

test('directory metadata survives event open/close and changes correctly when navigating between directories and home', () => {
  const elements = new Map();
  let route = { view: 'parties', id: '' };
  const initial = { status: 200, kind: 'parties', id: '', payload: { parties: [] } };
  const document = {
    title: titles.parties,
    querySelector: selector => elements.get(selector),
    getElementById: id => id === 'qdpInitialArchive' ? { content: { textContent: JSON.stringify(initial) } } : elements.get(id),
    createElement: () => ({ remove() { elements.delete(this.id); } }),
    head: { appendChild: item => elements.set(item.id, item) }
  };
  for (const [selector, content] of meta.tags('party', { id: 'ALPHA-1', name: 'Alpha' })) elements.set(selector, { content });
  const canonical = { setAttribute(name, value) { this[name] = value; } };
  elements.set('link[rel="canonical"]', canonical);
  const window = { QDPEventMetadata: globalThis.QDPEventMetadata, QDPProfileMetadata: meta };
  const restore = archiveSource.slice(archiveSource.indexOf('    restoreMetadata() {'), archiveSource.indexOf('    baseUrl() {'));
  const context = vm.createContext({ window, document, Map, Date, Promise, console, routeParams: () => route });
  vm.runInContext(`window.QDPArchive = { active: true, profile: null, ${restore} };`, context);
  vm.runInContext(linksSource, context);
  window.QDPArchive.restoreMetadata();
  const event = { eventId: 'EVENT-1', title: 'Public night', start: '2030-10-01T23:00:00-04:00' };
  window.QDPEventLinks.apply(event);
  window.QDPEventLinks.clear();
  assert.equal(document.title, titles.parties);
  assert.equal(canonical.href, meta.directoryUrl('parties'));
  assert.equal(elements.get('meta[name="description"]').content, descriptions.parties);
  route = { view: 'venues', id: '' };
  window.QDPArchive.restoreMetadata();
  assert.equal(document.title, titles.venues);
  assert.equal(elements.get('meta[name="description"]').content, descriptions.venues);
  route = { view: 'collectives', id: '' };
  window.QDPArchive.restoreMetadata();
  assert.equal(document.title, titles.collectives);
  assert.equal(elements.get('meta[name="description"]').content, descriptions.home);
  window.QDPArchive.active = false;
  document.title = 'Queer Dance Philly';
  window.QDPEventLinks.clear();
  assert.equal(canonical.href, meta.origin + '/');
  assert.equal(elements.get('meta[name="description"]').content, descriptions.home);
});

test('the approved homepage description is present in the static head only', () => {
  assert.equal(meta.homeDescription, descriptions.home);
  const [head, body] = html.split('</head>');
  assert.ok(head.includes(`content="${descriptions.home}"`));
  assert.ok(!body.includes(descriptions.home));
});
