import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { onRequestGet } from '../functions/api/archive.js';

const source = fs.readFileSync(new URL('../apps-script/archive-feed.gs', import.meta.url), 'utf8');
const sheets = {
  Artists: [
    ['ArtistID', 'StageName', 'Public_OK', 'Public_Bio_Short'],
    ['ALPHA', 'Alpha', 'Yes', 'Public bio'],
    ['PRIVATE', 'Private Artist', 'No', 'Do not publish']
  ],
  Venues: [
    ['VenueID', 'Public_Name', 'Public_OK', 'Address'],
    ['ROOM', 'Room', 'Yes', 'Public address'],
    ['HIDDEN', 'Hidden Room', 'No', 'Private address']
  ],
  Parties: [
    ['PartyID', 'PartyName', 'PartyInsta', 'PartyDesc'],
    ['NIGHT', 'The Night', '@night', 'Public party description']
  ],
  Collectives: [
    ['CollectiveID', 'CollectiveName', 'Public_Name', 'CollInsta', 'CollBio', 'Public_OK'],
    ['CREW', 'Internal crew name', 'The Crew', '@crew', 'Public collective bio', 'Yes'],
    ['SECRET', 'Secret crew', 'Secret crew', '@secret', 'Do not publish', 'No']
  ],
  'Archive 2024': [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime',
      'ArtistIDs', 'VenueID', 'Description', 'PartyID', 'HostCollectiveIDs (comma-separated)'],
    ['E1', 'Public night', 'Yes', '', '2024-09-01', '20:00:00', 'ALPHA,PRIVATE', 'ROOM',
      'Public description', 'NIGHT', 'CREW,SECRET'],
    ['E2', 'Private night', 'No', '', '2024-09-02', '20:00:00', 'ALPHA', 'HIDDEN', 'Secret description'],
    ['E3', 'Undisclosed room', 'Yes', '', '2024-09-03', '20:00:00', 'ALPHA', 'HIDDEN',
      'No address', '', 'SECRET']
  ],
  'Archive 2025': [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime'],
    ['E4', 'Cancelled', 'Yes', 'Cancelled', '2025-01-01', '20:00:00']
  ],
  Events_Archive: [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime'],
    ['E5', 'Another past night', 'Yes', '', '2025-01-02', '20:00:00']
  ],
  Events: [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime',
      'ArtistIDs', 'PartyID', 'HostCollectiveIDs (comma-separated)'],
    ['E6', 'Upcoming night', 'Yes', '', '2026-11-01', '20:00:00', 'ALPHA', 'NIGHT', 'CREW']
  ]
};

function appsScript() {
  const ss = { getSheetByName(name) {
    const rows = sheets[name];
    if (!rows) return null;
    return {
      getLastRow: () => rows.length,
      getLastColumn: () => rows[0].length,
      getRange: (r, c, h, w) => ({ getValues: () => rows.slice(r - 1, r - 1 + h)
        .map(row => Array.from({ length: w }, (_, i) => row[c - 1 + i] ?? '')) })
    };
  } };
  const context = vm.createContext({
    Map, Set, Date, JSON, Object, Array, RegExp, String,
    CONFIG: { SHEET_ARTISTS: 'Artists', SHEET_VENUES: 'Venues',
      SHEET_PARTIES: 'Parties', SHEET_COLLECTIVES: 'Collectives', SHEET_EVENTS: 'Events' },
    ss_: () => ss,
    trim: value => String(value ?? '').trim(),
    qdpPublicArtistFlags_: () => new Map([['ALPHA', { queer: true, trans: false }]]),
    qdpPublicDateTime_: (date, time) => date ? `${date}T${time || '00:00:00'}-04:00` : '',
    stripAllQdpMetadata_: value => value,
    extractFlyerUrl_: () => '',
    Utilities: { newBlob: value => ({ getBytes: () => Buffer.from(value) }) },
    Buffer
  });
  vm.runInContext(source, context);
  return { ss, context };
}

test('publisher builds only approved data and one source scan supports all views', () => {
  const { ss, context } = appsScript();
  const snapshot = context.qdpArchivePublishSource_(ss);
  assert.equal(snapshot.artists.length, 1);
  assert.equal(snapshot.venues.length, 1);
  assert.equal(snapshot.parties.length, 1);
  assert.equal(snapshot.collectives.length, 1);
  assert.equal(snapshot.parties[0].bio, 'Public party description');
  assert.equal(snapshot.collectives[0].name, 'The Crew');
  assert.equal(snapshot.artists[0].queerArtist, true);
  assert.equal(snapshot.artists[0].transArtist, false);
  assert.deepEqual(Array.from(snapshot.months, item => item.count), [1, 2]);
  assert.equal(snapshot.artistEntries.ALPHA.profile.count, 3);
  assert.equal(snapshot.artistEntries.ALPHA.events.some(event => event.eventId === 'E6'), true);
  assert.equal(snapshot.partyEntries.NIGHT.events.length, 2);
  assert.equal(snapshot.collectiveEntries.CREW.events.length, 2);
  assert.equal(snapshot.partyEntries.NIGHT.events[0].collectiveIds.includes('SECRET'), false);
  assert.equal(snapshot.monthEntries['2024-09'].events.length, 2);
  const hidden = snapshot.monthEntries['2024-09'].events.find(event => event.eventId === 'E3');
  assert.equal(hidden.venue, 'Location not disclosed');
  assert.equal(hidden.address, '');
  assert.equal(hidden.venueId, '');
  assert.equal(JSON.stringify(snapshot).includes('Secret description'), false);
  assert.equal(JSON.stringify(snapshot).includes('Private address'), false);
  assert.equal(JSON.stringify(snapshot).includes('Private Artist'), false);
  assert.equal(JSON.stringify(snapshot).includes('Secret crew'), false);
  assert.equal(JSON.stringify(snapshot).includes('Do not publish'), false);
  assert.equal(snapshot.artistEntries.ALPHA.events[0].queerArtist, true);
  const liveProfile = context.qdpArchiveResource_('archiveartist', { id: 'ALPHA' });
  assert.deepEqual(Array.from(snapshot.artistEntries.ALPHA.events, item => item.eventId),
    Array.from(liveProfile.events, item => item.eventId));
  assert.equal(snapshot.artistEntries.ALPHA.profile.count, liveProfile.profile.count);
  assert.equal(context.qdpArchiveResource_('archiveparty', { id: 'NIGHT' }).events.length, 2);
  assert.equal(context.qdpArchiveResource_('archivecollective', { id: 'CREW' }).events.length, 2);
  const liveMonths = context.qdpArchiveResource_('archivemonths', {});
  assert.deepEqual(Array.from(snapshot.months, item => `${item.month}:${item.count}`),
    Array.from(liveMonths.months, item => `${item.month}:${item.count}`));
});

test('publisher commits manifest last and skips writes when data has not changed', () => {
  const { context } = appsScript();
  const properties = new Map([
    ['QDP_ARCHIVE_CF_ACCOUNT_ID', 'a'.repeat(32)],
    ['QDP_ARCHIVE_CF_NAMESPACE_ID', 'b'.repeat(32)],
    ['QDP_ARCHIVE_CF_API_TOKEN', 'private-token']
  ]);
  const calls = [];
  context.PropertiesService = { getScriptProperties: () => ({
    getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value)
  }) };
  context.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  context.Utilities.computeDigest = () => Buffer.from('digest');
  context.Utilities.DigestAlgorithm = { SHA_256: 'SHA_256' };
  context.Utilities.base64EncodeWebSafe = value => Buffer.from(value).toString('base64url');
  context.Utilities.getUuid = () => 'revision-1';
  context.UrlFetchApp = { fetch: (url, options) => {
    calls.push({ url, options });
    const bulk = url.endsWith('/bulk');
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
      success: true, result: bulk
        ? { successful_key_count: JSON.parse(options.payload).length, unsuccessful_keys: [] } : {}
    }) };
  } };
  context.Logger = { log() {} };
  context.qdpArchivePublish();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.endsWith('/bulk'), true);
  assert.equal(calls[1].url.includes('/values/'), true);
  assert.equal(calls[1].options.payload.includes('revision-1'), true);
  context.qdpArchivePublish();
  assert.equal(calls.length, 2);
});

test('Pages serves a prepared profile without calling Apps Script and denies removed IDs', async () => {
  const { ss, context } = appsScript();
  const snapshot = context.qdpArchivePublishSource_(ss);
  snapshot.artists[0].name = '[DJ Alpha]';
  snapshot.venues[0].name = '[The Room]';
  snapshot.artistEntries.ALPHA.profile.name = '[DJ Alpha]';
  snapshot.artistEntries.ALPHA.events[0].venue = '[The Room]';
  const records = context.qdpArchiveKvRecords_(snapshot, 'revision-1');
  assert.equal(records.length, 19);
  const values = new Map(records.map(({ key, value }) => [key, JSON.parse(value)]));
  values.set('qdp-archive:v1:manifest', {
    schema: 1, revision: 'revision-1', artists: ['ALPHA'], venues: ['ROOM'],
    parties: ['NIGHT'], collectives: ['CREW'],
    months: ['2024-09', '2025-01']
  });
  const kv = { get: async key => values.get(key) ?? null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected live Apps Script request'); };
  try {
    const request = resource => ({
      request: new Request(`https://massive.example/api/archive?${resource}`),
      env: { QDP_ARCHIVE_KV: kv }
    });
    const artist = await onRequestGet(request('resource=artist&id=ALPHA'));
    assert.equal(artist.status, 200);
    assert.equal(artist.headers.get('X-QDP-Archive-Source'), 'prepared');
    const artistData = await artist.json();
    assert.equal(artistData.events.length, 3);
    assert.equal(artistData.profile.name, 'DJ Alpha');
    assert.equal(artistData.events[0].venue, 'The Room');
    const directory = await onRequestGet(request('resource=artists'));
    const artistList = (await directory.json()).artists;
    assert.equal(artistList[0].queerArtist, true);
    assert.equal(artistList[0].name, 'DJ Alpha');
    const venueList = await onRequestGet(request('resource=venues'));
    assert.equal((await venueList.json()).venues[0].name, 'The Room');
    const partyList = await onRequestGet(request('resource=parties'));
    assert.equal((await partyList.json()).parties[0].name, 'The Night');
    const collectiveList = await onRequestGet(request('resource=collectives'));
    assert.equal((await collectiveList.json()).collectives[0].name, 'The Crew');
    const party = await onRequestGet(request('resource=party&id=NIGHT'));
    assert.equal((await party.json()).events.length, 2);
    const collective = await onRequestGet(request('resource=collective&id=CREW'));
    assert.equal((await collective.json()).events.length, 2);
    const month = await onRequestGet(request('resource=month&month=2024-09'));
    assert.equal((await month.json()).events.length, 2);
    const removed = await onRequestGet(request('resource=artist&id=PRIVATE'));
    assert.equal(removed.status, 404);
    const hiddenCollective = await onRequestGet(request('resource=collective&id=SECRET'));
    assert.equal(hiddenCollective.status, 404);
  } finally { globalThis.fetch = originalFetch; }
});

test('mixed Cloudflare revisions fall back to the live public feed', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return Response.json({ artists: [{ id: 'ALPHA', name: 'Alpha', publicOk: true }] });
  };
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  try {
    const context = {
      request: new Request('https://massive.example/api/archive?resource=artists'),
      env: { QDP_ARCHIVE_KV: { get: async key => key.endsWith('manifest')
        ? { schema: 1, revision: 'new' }
        : { revision: 'old', payload: { artists: [] } } } },
      waitUntil() {}
    };
    const response = await onRequestGet(context);
    assert.equal(upstreamCalls, 1);
    assert.equal(response.headers.get('X-QDP-Archive-Source'), null);
    assert.equal((await response.json()).artists[0].id, 'ALPHA');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('unpublished new directories answer immediately without a slow live fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected live Apps Script request'); };
  try {
    const kv = { get: async key => key.endsWith('manifest')
      ? { schema: 1, revision: 'old', artists: ['ALPHA'], venues: ['ROOM'] }
      : null };
    for (const resource of ['parties', 'collectives', 'party&id=NIGHT', 'collective&id=CREW']) {
      const response = await onRequestGet({
        request: new Request(`https://massive.example/api/archive?resource=${resource}`),
        env: { QDP_ARCHIVE_KV: kv }
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /waiting for the sheet/);
    }
  } finally { globalThis.fetch = originalFetch; }
});
