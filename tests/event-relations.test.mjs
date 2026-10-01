import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/event-relations.js';

test('event links include only public relations and gate parties until approval is published', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  const entries = {
    'qdp-archive:v1:artist:0': { revision: 'one', entries: {
      ALPHA: { profile: { id: 'ALPHA', name: '[DJ Alpha]', publicOk: true },
        events: [{ eventId: 'E1', public: true }] },
      PRIVATE: { profile: { id: 'PRIVATE', name: 'Private', publicOk: false },
        events: [{ eventId: 'E1', public: true }] }
    } },
    'qdp-archive:v1:venue:0': { revision: 'one', entries: {
      ROOM: { profile: { id: 'ROOM', name: "Val's Lesbian Bar", publicOk: true },
        events: [{ eventId: 'E1', public: true }] }
    } },
    'qdp-archive:v1:party:0': { revision: 'one', entries: {
      MELT: { profile: { id: 'MELT', name: 'Melt', publicOk: true },
        events: [{ eventId: 'E1', public: true }] }
    } },
    'qdp-archive:v1:collective:0': { revision: 'one', entries: {
      CREW: { profile: { id: 'CREW', name: 'Crew', publicOk: true },
        events: [{ eventId: 'E1', public: false }] }
    } }
  };
  let gated = false;
  const kv = { get: async key => key.endsWith('manifest')
    ? { schema: 1, revision: 'one', partyPublicGate: gated }
    : entries[key] || { revision: 'one', entries: {} } };
  const request = new Request('https://massive.example/api/event-relations?event=E1');
  try {
    const before = await onRequestGet({ request, env: { QDP_ARCHIVE_KV: kv }, waitUntil() {} });
    assert.deepEqual((await before.json()).related.map(item => [item.kind, item.name]),
      [['artist', 'DJ Alpha'], ['venue', "Val's Lesbian Bar"]]);
    gated = true;
    const after = await onRequestGet({ request, env: { QDP_ARCHIVE_KV: kv }, waitUntil() {} });
    assert.deepEqual((await after.json()).related.map(item => item.name),
      ['DJ Alpha', "Val's Lesbian Bar", 'Melt']);
  } finally { globalThis.caches = previousCaches; }
});
