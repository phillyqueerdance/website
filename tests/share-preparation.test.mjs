import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPublicEvents, GitHubImageStore, prepareImages } from '../scripts/prepare-share-images.mjs';
import { shareArtifact } from '../functions/share-image-artifact.js';
import { renderShareImage } from '../scripts/render-share-image.mjs';
import fs from 'node:fs/promises';

const event = { eventId: 'NEW-1', title: 'New dance', public: true,
  start: '2026-10-23T21:00:00-04:00', flyerUrl: 'https://images.example/new.png' };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('the native preparation renderer produces the intended PNG dimensions with the bundled font', async () => {
  const bytes = await renderShareImage(event, { type: 'image/png',
    bytes: await fs.readFile(new URL('../melt1017-wide.png', import.meta.url)) });
  assert.equal(bytes.readUInt32BE(16), 900);
  assert.equal(bytes.readUInt32BE(20), 1067);
});

test('preparation uses public website feeds, prioritizes current events, and skips withdrawn and invalid rows', async () => {
  const paths = [];
  const old = { ...event, eventId: 'OLD-1' };
  const events = await collectPublicEvents('https://preview.example', async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    paths.push(url.pathname + url.search);
    if (url.pathname === '/api/events') return Response.json({ events: [event,
      { ...event, eventId: 'PRIVATE', public: false }, { ...event, eventId: 'CANCELLED', status: 'cancelled' },
      { ...event, eventId: '../bad' }, { ...event, eventId: 'NO-FLYER', flyerUrl: '' }] });
    if (url.searchParams.get('resource') === 'months') return Response.json({ months: [
      { month: '2026-09' }, { month: 'bad' }, { month: '2026-10' }, { month: '2026-10' }] });
    return Response.json({ events: [{ ...event, title: 'Older duplicate' }, old] });
  });
  assert.deepEqual(events.map(item => item.eventId), ['NEW-1', 'OLD-1']);
  assert.equal(events[0].title, event.title);
  assert.deepEqual(paths, ['/api/events', '/api/archive?resource=months',
    '/api/archive?resource=month&month=2026-10', '/api/archive?resource=month&month=2026-09']);
});

test('unchanged prepared images cause no flyer downloads, rendering, or writes', async () => {
  const artifact = await shareArtifact(event);
  const store = { inventory: async () => ({ assets: new Map([[artifact.name, 1]]) }) };
  const fail = () => { throw new Error('Unchanged images must be reused'); };
  const stats = await prepareImages({ events: [event], store, fetcher: fail, render: fail, log: fail });
  assert.deepEqual(stats, { prepared: 0, reused: 1, unavailable: 0, pending: 0, removed: 0 });
});

test('preparation limits backfill, saves a valid image, and removes only obsolete generated assets', async () => {
  const assets = new Map([[`event-${'a'.repeat(64)}.png`, 1], ['README.txt', 2]]);
  const uploaded = [], removed = [], fetched = [];
  const store = { inventory: async () => ({ assets }),
    upload: async (artifact, bytes) => { uploaded.push(artifact.name); assert.deepEqual(bytes, png); assets.set(artifact.name, 3); },
    remove: async (_, name) => { removed.push(name); assets.delete(name); } };
  const stats = await prepareImages({ events: [event, { ...event, eventId: 'NEXT-1' }], store, limit: 1,
    fetcher: async (url, options) => { fetched.push(url); assert.equal(options.headers.Authorization, undefined);
      return new Response(png, { headers: { 'Content-Type': 'image/png' } }); },
    render: async (approved, flyer) => { assert.equal(approved.eventId, event.eventId); assert.deepEqual(flyer.bytes, png); return png; }, log() {} });
  assert.deepEqual(fetched, [event.flyerUrl]);
  assert.equal(uploaded.length, 1);
  assert.deepEqual(removed, [`event-${'a'.repeat(64)}.png`]);
  assert.equal(assets.has('README.txt'), true);
  assert.deepEqual(stats, { prepared: 1, reused: 0, unavailable: 0, pending: 1, removed: 1 });
});

test('an unavailable public flyer can retry later without publishing a broken image', async () => {
  const stats = await prepareImages({ events: [event],
    store: { inventory: async () => ({ assets: new Map() }), upload() { assert.fail('No upload'); } },
    fetcher: async () => new Response('unavailable', { status: 404 }),
    render() { assert.fail('No rendering'); }, log() {} });
  assert.equal(stats.unavailable, 1);
  assert.equal(stats.prepared, 0);
});

test('GitHub storage uses the workflow token only on its fixed repository and publishes a non-latest asset release', async () => {
  const calls = [];
  const store = new GitHubImageStore('test-workflow-token', { gap: 0, fetcher: async (raw, options) => {
    const url = new URL(raw);
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer test-workflow-token');
    if (options.method === 'GET') return new Response('missing', { status: 404 });
    if (url.hostname === 'api.github.com') {
      const body = JSON.parse(options.body);
      assert.equal(body.make_latest, 'false');
      assert.equal(body.prerelease, true);
      return Response.json({ id: 1, upload_url: 'https://uploads.github.com/repos/phillyqueerdance/website/releases/1/assets{?name,label}' });
    }
    assert.equal(options.headers['Content-Type'], 'image/png');
    assert.deepEqual(options.body, png);
    return Response.json({ id: 2, name: url.searchParams.get('name') });
  } });
  const artifact = await shareArtifact(event);
  await store.upload(artifact, png);
  await store.upload(artifact, png);
  assert.equal(calls.length, 3);
  await assert.rejects(store.request('https://images.example/steal'), /Invalid asset destination/);
  await assert.rejects(store.request('https://api.github.com/repos/another/project/releases'), /Invalid asset destination/);
  assert.equal(calls.length, 3);
});
