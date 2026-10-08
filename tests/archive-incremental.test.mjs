import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const sources = [['repository publisher', fs.readFileSync(new URL('../apps-script/archive-feed.gs', import.meta.url), 'utf8')]];
// Also exercise the complete user-installable file when validating a release.
if (process.env.QDP_PUBLIC_DATA_FILE) sources.push(['PublicData.gs release', fs.readFileSync(process.env.QDP_PUBLIC_DATA_FILE, 'utf8')]);

function publisher(source) {
  const profile = { id: 'A', name: 'Alpha', bio: 'Public bio', publicOk: true, count: 1 };
  const event = { eventId: 'E1', title: 'Public event', public: true, start: '2099-10-01T20:00:00-04:00', artistIds: ['A'] };
  const snapshot = { artists: [profile], venues: [], parties: [], collectives: [], months: [],
    artistEntries: { A: { profile, events: [event] } }, venueEntries: {}, partyEntries: {}, collectiveEntries: {},
    monthEntries: {}, eventEntries: { E1: event }, excludedEventIds: [] };
  const properties = new Map([
    ['QDP_ARCHIVE_CF_ACCOUNT_ID', 'a'.repeat(32)], ['QDP_ARCHIVE_CF_NAMESPACE_ID', 'b'.repeat(32)],
    ['QDP_ARCHIVE_CF_API_TOKEN', 'test-token']
  ]);
  const calls = [], values = new Map();
  let failure = '', serial = 0, locks = 0;
  const context = vm.createContext({ Date, Map, Set, Object, Array, JSON, String, RegExp,
    trim: value => String(value ?? '').trim(), ss_: () => ({}),
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key),
      setProperty: (key, value) => properties.set(key, value) }) },
    LockService: { getScriptLock: () => ({ waitLock() { locks++; }, releaseLock() { locks--; } }) },
    Utilities: { newBlob: value => ({ getBytes: () => Buffer.from(value) }),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_algorithm, value) => createHash('sha256').update(value).digest(),
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url') + '=',
      getUuid: () => 'manifest-' + ++serial, sleep() {} },
    Logger: { log() {} }, UrlFetchApp: { fetch: (url, options) => {
      const bulk = url.endsWith('/bulk'), body = JSON.parse(options.payload);
      calls.push({ url, bulk, body });
      if (failure === 'bulk' && bulk) return { getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ success: true, result: { successful_key_count: 0, unsuccessful_keys: [body[0].key] } }) };
      if (failure === 'manifest' && !bulk) return { getResponseCode: () => 400,
        getContentText: () => JSON.stringify({ success: false }) };
      if (bulk) body.forEach(record => values.set(record.key, JSON.parse(record.value)));
      else values.set('qdp-archive:v1:manifest', body);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ success: true,
        result: bulk ? { successful_key_count: body.length, unsuccessful_keys: [] } : {} }) };
    } }
  });
  vm.runInContext(source, context);
  context.qdpArchivePublishSource_ = () => snapshot;
  return { context, snapshot, properties, calls, values, fail: type => { failure = type; }, locks: () => locks };
}

for (const [name, source] of sources) {
  test(`${name}: migrates once, skips unchanged runs, and writes only the two records affected by a bio edit`, () => {
    const f = publisher(source);
    const first = f.context.qdpArchivePublish();
    assert.equal(first.recordCount, 27); assert.equal(first.kvWriteCount, 28);
    const manifest = f.values.get('qdp-archive:v1:manifest');
    assert.equal(manifest.recordIndexVersion, 1);
    assert.equal(Object.keys(manifest.recordRevisions).length, 27);
    assert.ok(Object.values(manifest.recordRevisions).every(value => /^[\w-]{43}$/.test(value)));
    for (const [suffix, revision] of Object.entries(manifest.recordRevisions)) {
      assert.equal(f.values.get('qdp-archive:v1:' + suffix).revision, revision);
    }
    assert.ok(Buffer.byteLength(f.properties.get('QDP_ARCHIVE_RECORD_REVISIONS')) < 9000);
    f.calls.length = 0;
    assert.equal(f.context.qdpArchivePublish().kvWriteCount, 0);
    assert.equal(f.calls.length, 0);
    f.snapshot.artists[0].bio = 'Edited public bio';
    const edited = f.context.qdpArchivePublish();
    assert.equal(edited.recordCount, 2); assert.equal(edited.kvWriteCount, 3);
    assert.equal(edited.skippedRecordCount, 25);
    assert.deepEqual(f.calls[0].body.map(record => record.key).sort(), ['qdp-archive:v1:artist:1', 'qdp-archive:v1:artists']);
    assert.equal(f.calls.at(-1).bulk, false);
    const updated = f.values.get('qdp-archive:v1:manifest');
    assert.notEqual(updated.revision, manifest.revision);
    assert.equal(updated.recordRevisions['event:4'], manifest.recordRevisions['event:4']);
    assert.equal(f.locks(), 0);
  });

  test(`${name}: force publishing and namespace changes rebuild all records`, () => {
    const f = publisher(source); f.context.qdpArchivePublish(); f.calls.length = 0;
    assert.equal(f.context.qdpArchiveForcePublish().recordCount, 27);
    assert.equal(f.calls.at(-1).bulk, false);
    f.properties.set('QDP_ARCHIVE_CF_NAMESPACE_ID', 'c'.repeat(32)); f.calls.length = 0;
    assert.equal(f.context.qdpArchivePublish().recordCount, 27);
    assert.ok(f.calls.every(call => call.url.includes('c'.repeat(32))));
  });

  test(`${name}: missing or corrupt local ledgers trigger a full repair`, () => {
    const f = publisher(source); f.context.qdpArchivePublish();
    f.properties.delete('QDP_ARCHIVE_RECORD_REVISIONS');
    assert.equal(f.context.qdpArchivePublish().recordCount, 27);
    f.properties.set('QDP_ARCHIVE_RECORD_REVISIONS', '{broken');
    assert.equal(f.context.qdpArchivePublish().recordCount, 27);
  });

  for (const failure of ['bulk', 'manifest']) test(`${name}: a failed ${failure} write leaves the ledger unchanged and retries affected records`, () => {
    const f = publisher(source); f.context.qdpArchivePublish();
    const ledger = f.properties.get('QDP_ARCHIVE_RECORD_REVISIONS'), fingerprint = f.properties.get('QDP_ARCHIVE_LAST_PUBLISHED');
    const manifest = f.values.get('qdp-archive:v1:manifest');
    f.snapshot.artists[0].bio = 'Edited bio'; f.calls.length = 0; f.fail(failure);
    assert.throws(() => f.context.qdpArchivePublish(), /manifest was not updated|write failed/);
    assert.equal(f.properties.get('QDP_ARCHIVE_RECORD_REVISIONS'), ledger);
    assert.equal(f.properties.get('QDP_ARCHIVE_LAST_PUBLISHED'), fingerprint);
    assert.deepEqual(f.values.get('qdp-archive:v1:manifest'), manifest);
    if (failure === 'bulk') assert.ok(f.calls.every(call => call.bulk));
    assert.equal(f.locks(), 0);
    f.calls.length = 0; f.fail('');
    assert.equal(f.context.qdpArchivePublish().recordCount, 2);
    assert.equal(f.calls[0].body.length, 2);
    assert.equal(f.calls.at(-1).bulk, false);
  });

  test(`${name}: clearing a group writes its empty record and updates public IDs`, () => {
    const f = publisher(source); f.context.qdpArchivePublish(); f.calls.length = 0;
    f.snapshot.artists = []; f.snapshot.artistEntries = {};
    f.snapshot.eventEntries.E1.artistIds = [];
    f.context.qdpArchivePublish();
    assert.deepEqual(Object.keys(f.values.get('qdp-archive:v1:artist:1').entries), []);
    assert.deepEqual(f.values.get('qdp-archive:v1:manifest').artists, []);
    assert.equal(f.calls.at(-1).bulk, false);
  });

  test(`${name}: manifest-only changes cost one write and no bulk request`, () => {
    const f = publisher(source); f.context.qdpArchivePublish(); f.calls.length = 0;
    f.snapshot.excludedEventIds.push('WITHDRAWN');
    const result = f.context.qdpArchivePublish();
    assert.equal(result.recordCount, 0); assert.equal(result.kvWriteCount, 1);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].bulk, false);
    assert.deepEqual(f.values.get('qdp-archive:v1:manifest').excludedEventIds, ['WITHDRAWN']);
  });
}
