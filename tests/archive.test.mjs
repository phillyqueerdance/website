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
    ['PartyID', 'PartyName', 'PartyInsta', 'PartyDesc', 'PartyColls', 'Public_OK', 'PartyQueer'],
    ['NIGHT', 'The Night', '@night', 'Public party description', '', 'Yes', 'Yes'],
    ['OTHER', 'Other party', '', '', 'CREW', 'Yes', 'No'],
    ['PRIVATEPARTY', 'Private party', '@private', 'Do not publish this party', '', 'No', 'Yes']
  ],
  Collectives: [
    ['CollectiveID', 'CollectiveName', 'Public_Name', 'CollInsta', 'CollBio', 'Public_OK', 'CollParty'],
    ['CREW', 'Internal crew name', 'The Crew', '@crew', 'Public collective bio', 'Yes', 'NIGHT'],
    ['SECRET', 'Secret crew', 'Secret crew', '@secret', 'Do not publish', 'No', 'NIGHT']
  ],
  'Archive 2024': [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime',
      'ArtistIDs', 'VenueID', 'Description', 'PartyID', 'HostCollectiveIDs (comma-separated)'],
    ['E1', 'Public night', 'Yes', '', '2024-09-01', '20:00:00', 'ALPHA,PRIVATE', 'ROOM',
      'Public description', 'NIGHT', 'CREW,SECRET'],
    ['E2', 'Private night', 'No', '', '2024-09-02', '20:00:00', 'ALPHA', 'HIDDEN', 'Secret description'],
    ['E3', 'Undisclosed room', 'Yes', '', '2024-09-03', '20:00:00', 'ALPHA', 'HIDDEN',
      'No address', 'NIGHT', 'SECRET']
  ],
  'Archive 2025': [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime'],
    ['E4', 'Cancelled', 'Yes', 'Cancelled', '2025-01-01', '20:00:00']
  ],
  Events_Archive: [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime', 'PartyID'],
    ['E5', 'Another past night', 'Yes', '', '2025-01-02', '20:00:00', 'OTHER']
  ],
  Events: [
    ['EventID', 'Title_Public', 'Publish_To_Web', 'Status', 'StartDate', 'StartTime',
      'ArtistIDs', 'PartyID', 'HostCollectiveIDs (comma-separated)'],
    ['E6', 'Upcoming night', 'Yes', '', '2026-11-01', '20:00:00', 'ALPHA', 'NIGHT', 'CREW']
  ]
};

function appsScript(fixture = sheets) {
  const ss = { getSheetByName(name) {
    const rows = fixture[name];
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
    Utilities: { newBlob: value => ({ getBytes: () => Buffer.from(value) }),
      formatDate: date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) },
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
  assert.equal(snapshot.parties.length, 2);
  assert.equal(snapshot.collectives.length, 1);
  assert.equal(snapshot.parties.find(item => item.id === 'NIGHT').bio, 'Public party description');
  assert.equal(snapshot.parties.find(item => item.id === 'NIGHT').queerParty, true);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATEPARTY'), false);
  assert.equal(snapshot.collectives[0].name, 'The Crew');
  assert.equal(snapshot.artists[0].queerArtist, true);
  assert.equal(snapshot.artists[0].transArtist, false);
  assert.deepEqual(Array.from(snapshot.months, item => item.count), [1, 2]);
  assert.equal(snapshot.artistEntries.ALPHA.profile.count, 3);
  assert.equal(snapshot.artistEntries.ALPHA.events.some(event => event.eventId === 'E6'), true);
  assert.equal(snapshot.partyEntries.NIGHT.events.length, 3);
  assert.equal(snapshot.partyEntries.OTHER.events.length, 1);
  assert.equal(snapshot.collectiveEntries.CREW.events.length, 4);
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
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  assert.equal(snapshot.artistEntries.ALPHA.events[0].queerArtist, true);
  const liveProfile = context.qdpArchiveResource_('archiveartist', { id: 'ALPHA' });
  assert.deepEqual(Array.from(snapshot.artistEntries.ALPHA.events, item => item.eventId),
    Array.from(liveProfile.events, item => item.eventId));
  assert.equal(snapshot.artistEntries.ALPHA.profile.count, liveProfile.profile.count);
  assert.equal(context.qdpArchiveResource_('archiveparty', { id: 'NIGHT' }).events.length, 3);
  assert.equal(context.qdpArchiveResource_('archivecollective', { id: 'CREW' }).events.length, 4);
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
  const sleeps = [];
  context.Utilities.sleep = ms => sleeps.push(ms);
  context.UrlFetchApp = { fetch: (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new Error('Address unavailable: Cloudflare');
    const bulk = url.endsWith('/bulk');
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
      success: true, result: bulk
        ? { successful_key_count: JSON.parse(options.payload).length, unsuccessful_keys: [] } : {}
    }) };
  } };
  context.Logger = { log() {} };
  context.qdpArchivePublish();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.endsWith('/bulk'), true);
  assert.equal(calls[1].url.endsWith('/bulk'), true);
  assert.equal(calls[2].url.includes('/values/'), true);
  assert.equal(calls[2].options.payload.includes('revision-1'), true);
  const manifest = JSON.parse(calls[2].options.payload);
  assert.equal(manifest.partyPublicGate, true);
  assert.equal(manifest.eventIndexVersion, 1);
  assert.equal(manifest.eventShards, 8);
  assert.equal(manifest.eventIds.includes('E6'), true);
  assert.equal(manifest.eventIds.includes('E2'), false);
  assert.deepEqual(sleeps, [1000]);
  context.qdpArchivePublish();
  assert.equal(calls.length, 3);
});

test('publisher splits larger requests and never advances the manifest after a failed batch', () => {
  const { context } = appsScript();
  const synthetic = Array.from({ length: 4 }, (_, index) =>
    ({ key: `test:${index}`, value: 'x'.repeat(120) }));
  const batches = context.qdpArchiveBulkBatches_(synthetic, 300);
  assert.deepEqual(Array.from(batches, batch => batch.length), [2, 2]);
  assert.equal(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 300), true);

  const properties = new Map([
    ['QDP_ARCHIVE_CF_ACCOUNT_ID', 'a'.repeat(32)],
    ['QDP_ARCHIVE_CF_NAMESPACE_ID', 'b'.repeat(32)],
    ['QDP_ARCHIVE_CF_API_TOKEN', 'private-token']
  ]);
  context.PropertiesService = { getScriptProperties: () => ({
    getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value)
  }) };
  context.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  context.Utilities.computeDigest = () => Buffer.from('digest');
  context.Utilities.DigestAlgorithm = { SHA_256: 'SHA_256' };
  context.Utilities.base64EncodeWebSafe = value => Buffer.from(value).toString('base64url');
  context.Utilities.getUuid = () => 'revision-1';
  context.qdpArchiveBulkBatches_ = records => [records.slice(0, 1), records.slice(1)];
  const urls = [];
  context.UrlFetchApp = { fetch: (url, options) => {
    urls.push(url);
    const count = urls.length === 2 ? 0 : JSON.parse(options.payload).length;
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
      success: true, result: { successful_key_count: count, unsuccessful_keys: [] }
    }) };
  } };
  context.Logger = { log() {} };
  assert.throws(() => context.qdpArchivePublish(), /manifest was not updated/);
  assert.equal(urls.length, 2);
  assert.equal(properties.has('QDP_ARCHIVE_LAST_PUBLISHED'), false);
});

test('Pages serves a prepared profile without calling Apps Script and denies removed IDs', async () => {
  const { ss, context } = appsScript();
  const snapshot = context.qdpArchivePublishSource_(ss);
  snapshot.artists[0].name = '[DJ Alpha]';
  snapshot.venues[0].name = '[The Room]';
  snapshot.venues[0].queerVenue = true;
  snapshot.venueEntries.ROOM.profile.queerVenue = true;
  snapshot.artistEntries.ALPHA.profile.name = '[DJ Alpha]';
  snapshot.artistEntries.ALPHA.events[0].venue = '[The Room]';
  const records = context.qdpArchiveKvRecords_(snapshot, 'revision-1');
  assert.equal(records.length, 27);
  const values = new Map(records.map(({ key, value }) => [key, JSON.parse(value)]));
  values.set('qdp-archive:v1:manifest', {
    schema: 1, revision: 'revision-1', partyPublicGate: true,
    artists: ['ALPHA'], venues: ['ROOM'],
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
    const venueProfile = await onRequestGet(request('resource=venue&id=ROOM'));
    assert.equal((await venueProfile.json()).profile.queerVenue, true);
    const venueList = await onRequestGet(request('resource=venues'));
    const venueData = (await venueList.json()).venues[0];
    assert.equal(venueData.name, 'The Room');
    assert.equal(venueData.queerVenue, true);
    const partyList = await onRequestGet(request('resource=parties'));
    assert.equal((await partyList.json()).parties.find(item => item.id === 'NIGHT').name, 'The Night');
    const collectiveList = await onRequestGet(request('resource=collectives'));
    assert.equal((await collectiveList.json()).collectives[0].name, 'The Crew');
    const party = await onRequestGet(request('resource=party&id=NIGHT'));
    assert.equal((await party.json()).events.length, 3);
    const collective = await onRequestGet(request('resource=collective&id=CREW'));
    assert.equal((await collective.json()).events.length, 4);
    const month = await onRequestGet(request('resource=month&month=2024-09'));
    assert.equal((await month.json()).events.length, 2);
    const removed = await onRequestGet(request('resource=artist&id=PRIVATE'));
    assert.equal(removed.status, 404);
    const hiddenCollective = await onRequestGet(request('resource=collective&id=SECRET'));
    assert.equal(hiddenCollective.status, 404);
  } finally { globalThis.fetch = originalFetch; }
});

test('prepared profile links use public IDs and party and collective queer flags', async () => {
  const { ss, context } = appsScript();
  const snapshot = context.qdpArchivePublishSource_(ss);
  const related = [
    { kind: 'party', id: 'NIGHT', name: 'The Night' },
    { kind: 'collective', id: 'CREW', name: 'The Crew' },
    { kind: 'artist', id: 'PRIVATE', name: 'Private Artist' },
    { kind: 'party', id: 'NIGHT', name: 'Duplicate' }
  ];
  snapshot.artistEntries.ALPHA.profile.related = related;
  snapshot.parties.find(item => item.id === 'NIGHT').queerParty = true;
  snapshot.partyEntries.NIGHT.profile.queerParty = true;
  snapshot.collectives[0].queerCollective = true;
  snapshot.collectiveEntries.CREW.profile.queerCollective = true;
  const values = new Map(context.qdpArchiveKvRecords_(snapshot, 'revision-2')
    .map(({ key, value }) => [key, JSON.parse(value)]));
  values.set('qdp-archive:v1:manifest', {
    schema: 1, revision: 'revision-2', partyPublicGate: true,
    artists: ['ALPHA'], venues: ['ROOM'], parties: ['NIGHT', 'OTHER'],
    collectives: ['CREW'], months: ['2024-09', '2025-01']
  });
  const kv = { get: async key => values.get(key) ?? null };
  const request = resource => ({
    request: new Request(`https://massive.example/api/archive?${resource}`),
    env: { QDP_ARCHIVE_KV: kv }
  });
  const artists = await (await onRequestGet(request('resource=artist&id=ALPHA'))).json();
  assert.deepEqual(artists.profile.related.map(item => [item.kind, item.id]),
    [['party', 'NIGHT'], ['collective', 'CREW']]);
  values.get('qdp-archive:v1:manifest').partyPublicGate = false;
  const beforePartyApproval = await (await onRequestGet(request('resource=artist&id=ALPHA'))).json();
  assert.deepEqual(beforePartyApproval.profile.related.map(item => item.kind), ['collective']);
  values.get('qdp-archive:v1:manifest').partyPublicGate = true;
  const parties = await (await onRequestGet(request('resource=parties'))).json();
  assert.equal(parties.parties.find(item => item.id === 'NIGHT').queerParty, true);
  const collectives = await (await onRequestGet(request('resource=collectives'))).json();
  assert.equal(collectives.collectives[0].queerCollective, true);
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

test('party pages stay unpublished until the snapshot declares a Public_OK gate', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected live Apps Script request'); };
  try {
    const kv = { get: async key => key.endsWith('manifest')
      ? { schema: 1, revision: 'old', artists: ['ALPHA'], venues: ['ROOM'], parties: ['NIGHT'] }
      : { revision: 'old', payload: { parties: [{ id: 'NIGHT', name: 'Night', publicOk: true }] } } };
    for (const resource of ['parties', 'party&id=NIGHT']) {
      const response = await onRequestGet({
        request: new Request(`https://massive.example/api/archive?resource=${resource}`),
        env: { QDP_ARCHIVE_KV: kv }
      });
      assert.equal(response.status, 503);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a propagating party snapshot never falls back to the old Apps Script response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected ungated live response'); };
  try {
    const kv = { get: async key => key.endsWith('manifest')
      ? { schema: 1, revision: 'new', partyPublicGate: true, parties: ['NIGHT'] }
      : { revision: 'old', payload: { parties: [{ id: 'NIGHT', name: 'Night', publicOk: true }] } } };
    const response = await onRequestGet({
      request: new Request('https://massive.example/api/archive?resource=parties'),
      env: { QDP_ARCHIVE_KV: kv }
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.fetch = originalFetch; }
});

test('the permanent event index includes active-sheet past events and one authoritative copy per ID', () => {
  const fixture = structuredClone(sheets);
  fixture.Events.push(['ENDED', 'Ended active event', 'Yes', '', '2026-10-01', '20:00:00', 'ALPHA', 'NIGHT', 'CREW']);
  fixture.Events.push(['E1', 'Updated public night', 'Yes', '', '2024-09-01', '20:00:00', 'ALPHA', 'NIGHT', 'CREW']);
  const { ss, context } = appsScript(fixture);
  context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-07T12:00:00Z'])); } };
  const snapshot = context.qdpArchivePublishSource_(ss);
  assert.equal(snapshot.eventEntries.ENDED.title, 'Ended active event');
  assert.equal(snapshot.monthEntries['2026-10'].events[0].eventId, 'ENDED');
  assert.equal(snapshot.eventEntries.E1.title, 'Updated public night');
  assert.equal(snapshot.monthEntries['2024-09'].events.filter(event => event.eventId === 'E1').length, 1);
  assert.equal(snapshot.eventEntries.E6.start.startsWith('2026-11'), true);
  assert.equal(snapshot.monthEntries['2026-11'], undefined);
  assert.deepEqual(Array.from(snapshot.eventEntries.E1.related, item => item.kind), ['artist', 'party', 'collective']);
});

test('withdrawing an active event also suppresses its archived copy', () => {
  const fixture = structuredClone(sheets);
  fixture.Events.push(['E1', 'Withdrawn active event', 'No', '', '2024-09-01', '20:00:00', 'ALPHA', 'NIGHT', 'CREW']);
  const { ss, context } = appsScript(fixture);
  const snapshot = context.qdpArchivePublishSource_(ss);
  assert.equal(snapshot.eventEntries.E1, undefined);
  assert.equal(snapshot.excludedEventIds.includes('E1'), true);
  assert.equal(snapshot.monthEntries['2024-09'].events.some(event => event.eventId === 'E1'), false);
  assert.equal(snapshot.artistEntries.ALPHA.events.some(event => event.eventId === 'E1'), false);
});

test('publisher fails closed when the party approval column is missing', () => {
  const fixture = structuredClone(sheets);
  fixture.Parties[0][5] = 'Unused';
  const { ss, context } = appsScript(fixture);
  assert.throws(() => context.qdpArchivePublishSource_(ss), /Parties requires its ID and public fields/);
});
