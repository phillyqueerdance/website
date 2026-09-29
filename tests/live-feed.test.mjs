import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet } from '../functions/api/events.js';

test('same Apps Script publishes only fields from its existing public events response', () => {
  const source = fs.readFileSync(new URL('../apps-script/archive-feed.gs', import.meta.url), 'utf8');
  const writes = [];
  const context = vm.createContext({
    Date, JSON, String, Number, RegExp, Object,
    trim: value => String(value ?? '').trim(),
    stripAllQdpMetadata_: value => value.split('--- QDP WEB ---')[0].trim(),
    doGet: request => {
      assert.equal(request.parameter.resource, 'events');
      return { getContent: () => JSON.stringify({ generatedAt: '2026-09-29T22:00:00Z', events: [{
        eventId: 'PUBLIC', title: 'Public party', start: '2030-09-29T20:00:00-04:00',
        end: '2030-09-30T00:00:00-04:00', venue: 'Public venue', address: 'Public address',
        hasVenueId: true, explicitQueer: true, queerArtist: false, transArtist: true,
        description: 'Public description\n--- QDP WEB ---\nPrivate metadata',
        flyerUrl: 'https://example.com/flyer.jpg', internalNote: 'Private note'
      }] }) };
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => ({
      QDP_ARCHIVE_CF_ACCOUNT_ID: 'a'.repeat(32), QDP_ARCHIVE_CF_NAMESPACE_ID: 'b'.repeat(32),
      QDP_ARCHIVE_CF_API_TOKEN: 'private-token'
    })[key] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { newBlob: value => ({ getBytes: () => Buffer.from(value) }) },
    Buffer,
    UrlFetchApp: { fetch: (url, options) => {
      writes.push({ url, options });
      return { getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ success: true, result: {} }) };
    } },
    Logger: { log() {} }
  });
  vm.runInContext(source, context);
  context.qdpLivePublish();
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /qdp-live%3Av1%3Afeed$/);
  const record = JSON.parse(writes[0].options.payload);
  assert.equal(record.schema, 1);
  assert.equal(record.payload.events[0].hasVenueId, true);
  assert.equal(record.payload.events[0].description, 'Public description');
  assert.equal(JSON.stringify(record).includes('Private note'), false);
  assert.equal(JSON.stringify(record).includes('Private metadata'), false);
});

test('prepared live feed skips Google and filters ended listings', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Google should not be requested'); };
  try {
    const response = await onRequestGet({
      request: new Request('https://massive.example/api/events'),
      env: { QDP_ARCHIVE_KV: { get: async key => {
        assert.equal(key, 'qdp-live:v1:feed');
        return { schema: 1, publishedAt: new Date().toISOString(), payload: {
          generatedAt: '2026-09-29T22:00:00Z', events: [
            { eventId: 'FUTURE', title: 'Future', start: '2030-09-29T20:00:00-04:00' },
            { eventId: 'OLD', title: 'Past', start: '2020-01-01T20:00:00-05:00' }
          ]
        } };
      } } }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-QDP-Cache'), 'PREPARED');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=30');
    assert.deepEqual((await response.json()).events.map(event => event.eventId), ['FUTURE']);
  } finally { globalThis.fetch = originalFetch; }
});

test('stale prepared feed uses the existing live Google path', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return Response.json({ events: [
      { eventId: 'FUTURE', title: 'Fresh', start: '2030-09-29T20:00:00-04:00' }
    ] });
  };
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  try {
    const response = await onRequestGet({
      request: new Request('https://massive.example/api/events'),
      env: { QDP_ARCHIVE_KV: { get: async () => ({
        schema: 1, publishedAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
        payload: { events: [] }
      }) } },
      waitUntil() {}
    });
    assert.equal(upstreamCalls, 1);
    assert.equal(response.headers.get('X-QDP-Cache'), 'MISS');
    assert.equal((await response.json()).events[0].title, 'Fresh');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
