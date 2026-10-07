import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderLivePoster } from '../functions/live-poster.js';
import { onRequestGet } from '../functions/index.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the prepared page displays current event cards in HTML before app.js loads', async () => {
  const recorded = new Map();
  const previousRewriter = globalThis.HTMLRewriter;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('The page must not wait for Google'); };
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) {
      this.handlers.push([selector, handler]);
      return this;
    }
    transform(response) {
      for (const [selector, handler] of this.handlers) {
        handler.element({
          setInnerContent: (content, options) => recorded.set(selector, { content, options }),
          setAttribute() {}
        });
      }
      return response;
    }
  };
  try {
    const response = await onRequestGet({
      request: new Request('https://massive.example/'),
      env: {
        ASSETS: { fetch: async () => new Response(html, {
          headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'" }
        }) },
        QDP_ARCHIVE_KV: { get: async key => {
          assert.equal(key, 'qdp-live:v1:feed');
          return { schema: 1, publishedAt: new Date().toISOString(), payload: {
            events: [{ eventId: 'QDP1', title: '🏳️‍🌈 Dance <tonight>',
              start: '2030-09-29T20:00:00-04:00', venue: 'Some & Place' }]
          } };
        } }
      }
    });
    assert.equal(response.headers.get('X-QDP-Initial-Events'), 'PREPARED');
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'self'");
    assert.match(html, /id="qdpInitialEvents"/);
    assert.match(html, /id="eventStack"/);
    assert.match(recorded.get('#eventStack').content, /Dance &lt;tonight&gt;/);
    assert.match(recorded.get('#eventStack').content, /Some &amp; Place/);
    assert.match(recorded.get('#eventStack').content, /href="\/\?event=QDP1"/);
    assert.equal(recorded.get('#eventStack').options.html, true);
    assert.deepEqual(JSON.parse(recorded.get('#qdpInitialEvents').content).events[0].eventId, 'QDP1');
    assert.ok(recorded.get('#dateLabel').content);
  } finally {
    globalThis.HTMLRewriter = previousRewriter;
    globalThis.fetch = previousFetch;
  }
});

test('a warm homepage uses prepared HTML without a second KV read', async () => {
  const previousCaches = globalThis.caches;
  const previousRewriter = globalThis.HTMLRewriter;
  const edge = new Map();
  let reads = 0;
  globalThis.caches = { default: {
    match: async key => edge.get(key.url)?.clone() ?? null,
    put: async (key, response) => edge.set(key.url, response.clone())
  } };
  globalThis.HTMLRewriter = class {
    on() { return this; }
    transform(response) { return response; }
  };
  const context = noise => ({
    request: new Request(`https://massive.example/?noise=${noise}`),
    env: { ASSETS: { fetch: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) },
      QDP_ARCHIVE_KV: { get: async () => {
        reads++;
        return { schema: 1, publishedAt: new Date().toISOString(), payload: { events: [] } };
      } } }
  });
  try {
    assert.equal((await onRequestGet(context('one'))).headers.get('X-QDP-Initial-Events'), 'PREPARED');
    assert.equal((await onRequestGet(context('two'))).headers.get('X-QDP-Initial-Events'), 'PREPARED');
    assert.equal(reads, 1);
  } finally { globalThis.caches = previousCaches; globalThis.HTMLRewriter = previousRewriter; }
});

test('poster renderer groups same-time cards and escapes untrusted fields', () => {
  const result = renderLivePoster([
    { eventId: 'A"><script>', title: 'First', start: '2030-09-29T20:00:00-04:00' },
    { eventId: 'B', title: '<img src=x onerror=alert(1)>', start: '2030-09-29T20:00:00-04:00' }
  ], new Date('2030-09-29T12:00:00-04:00'));
  assert.equal((result.markup.match(/class="event-time-group"/g) || []).length, 1);
  assert.match(result.markup, /event-row same-time/);
  assert.doesNotMatch(result.markup, /<script>|<img src=x/);
  assert.match(result.markup, /A&quot;&gt;&lt;script&gt;/);
  assert.match(result.markup, /September 29th/);
});
