import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet as eventApi } from '../functions/api/event.js';
import { onRequestGet as relations } from '../functions/api/event-relations.js';
import { renderEventDetail } from '../functions/event-page.js';
import { shard } from '../functions/event-records.js';

const rawNames = [
  { kind: 'artist', id: 'GINA', name: '[G I N A]' },
  { kind: 'artist', id: 'EXACT-2', name: ' [DJ Two] ' },
  { kind: 'artist', id: 'NORMAL', name: 'DJ [guest]' },
  { kind: 'artist', id: 'EMPTY', name: '[]' },
  { kind: 'artist', id: 'PRIVATE', name: '[Private Artist]' }
];
const expected = ['G I N A', 'DJ Two', 'DJ [guest]'];

for (const versioned of [false, true]) {
  test(`indexed event API, related-link API, and initial HTML hide matching brackets (${versioned ? 'per-record' : 'global'} versions)`, async () => {
    const eventId = 'GINA-NIGHT';
    const key = `event:${shard(eventId, 8)}`;
    const manifest = { schema: 1, revision: 'global-one', eventIndexVersion: 1, eventShards: 8,
      eventIds: [eventId], artists: ['GINA', 'EXACT-2', 'NORMAL', 'EMPTY'], venues: [], parties: [], collectives: [],
      ...(versioned ? { recordIndexVersion: 1, recordRevisions: { [key]: 'record-one' } } : {}) };
    const raw = { eventId, public: true, title: 'Public night', start: '2099-10-01T20:00:00-04:00',
      artistIds: manifest.artists, related: structuredClone(rawNames) };
    const record = { revision: versioned ? 'record-one' : manifest.revision, entries: { [eventId]: raw } };
    const context = path => ({ request: new Request('https://qdp.example' + path),
      env: { QDP_PUBLIC_FEED_KV: { get: async name => name.endsWith('manifest') ? manifest : record } } });
    const eventResponse = await eventApi(context('/api/event?event=' + eventId));
    assert.equal(eventResponse.status, 200);
    const event = (await eventResponse.json()).event;
    assert.deepEqual(event.related.map(item => item.name), expected);
    assert.deepEqual(event.related.map(item => item.id), ['GINA', 'EXACT-2', 'NORMAL']);
    const links = await relations(context('/api/event-relations?event=' + eventId));
    assert.equal(links.status, 200);
    assert.deepEqual((await links.json()).related.map(item => item.name), expected);
    const html = renderEventDetail(event, 'https://qdp.example/?event=' + eventId);
    assert.match(html, />G I N A<\/a>/);
    assert.match(html, />DJ Two<\/a>/);
    assert.doesNotMatch(html, /\[G I N A\]|\[DJ Two\]|Private Artist/);
    assert.deepEqual(raw.related, rawNames, 'display cleanup must not mutate source names or IDs');
  });
}

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const render = app.slice(app.indexOf('function loadEventRelations('), app.indexOf('\nfunction orderedEvents('));
function browser() {
  let fetched = 0;
  const context = vm.createContext({ URL, Date, Map, Promise,
    location: { origin: 'https://qdp.example' },
    document: { createElement: () => ({ setAttribute() {} }) },
    fetch: async () => { fetched++; return { ok: true, json: async () => ({ related: structuredClone(rawNames) }) }; }
  });
  vm.runInContext('const eventRelations = new Map(); const RELATIONS_CACHE_MS = 60000; let activeEventId = "E1";\n' + render, context);
  const section = { hidden: true }, links = { children: [], replaceChildren() { this.children = []; },
    appendChild(link) { this.children.push(link); }, get childElementCount() { return this.children.length; } };
  const draw = async prepared => {
    context.loadEventRelations('E1', { isConnected: true }, section, links, prepared);
    await new Promise(resolve => setImmediate(resolve));
    return links.children.map(link => link.textContent);
  };
  return { draw, section, links, fetched: () => fetched };
}

test('browser hides brackets in embedded names and reuses cached names without changing them', async () => {
  const f = browser(), prepared = structuredClone(rawNames.slice(0, 4));
  assert.deepEqual(await f.draw(prepared), expected);
  assert.deepEqual(await f.draw(), expected);
  assert.equal(f.fetched(), 0);
  assert.equal(f.section.hidden, false);
  assert.deepEqual(prepared, rawNames.slice(0, 4));
  assert.ok(f.links.children[0].href.includes('id=GINA'));
});

test('browser hides brackets in fetched bubbles and subsequent cached bubbles', async () => {
  const f = browser();
  // The public API owns approval filtering; the renderer owns displayed names.
  const displayNames = [...expected, 'Private Artist'];
  assert.deepEqual(await f.draw(), displayNames);
  assert.deepEqual(await f.draw(), displayNames);
  assert.equal(f.fetched(), 1);
});
