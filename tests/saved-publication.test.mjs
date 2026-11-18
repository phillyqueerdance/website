import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// PublicData.gs is maintained as a complete Apps Script replacement. Point
// this optional integration pass at the same file supplied for installation.
const source = process.env.QDP_PUBLIC_DATA_SOURCE && readFileSync(process.env.QDP_PUBLIC_DATA_SOURCE, 'utf8');
const integration = (name, fn) => test(name, {skip: !source && 'Set QDP_PUBLIC_DATA_SOURCE to the maintained PublicData.gs'}, fn);
const plain = value => JSON.parse(JSON.stringify(value));
function setup() {
  const props = new Map([
    ['QDP_ARCHIVE_ADMIN_DIRTY_V1', JSON.stringify({revision: 'saved'})],
    ['QDP_ARCHIVE_CF_ACCOUNT_ID', 'a'.repeat(32)], ['QDP_ARCHIVE_CF_NAMESPACE_ID', 'b'.repeat(32)],
    ['QDP_ARCHIVE_CF_API_TOKEN', 'fixture-token']
  ]);
  const oldPayload = {generatedAt: '2026-11-01T00:00:00.000Z', events: [{eventId: 'OLD', title: 'Previously published'}]};
  const records = new Map([['qdp-live:v1:feed', {schema: 1, publishedAt: '2026-11-01T00:00:00.000Z', payload: oldPayload}]]);
  const requests = [];
  let sheetReads = 0, locked = false;
  const context = vm.createContext({Date, Map, Set, JSON, console: {error() {}},
    trim: value => String(value || '').trim(), Logger: {log() {}}, ScriptApp: {getScriptId: () => 'fixture'},
    PropertiesService: {getScriptProperties: () => ({getProperty: key => props.get(key) || null,
      setProperty: (key, value) => props.set(key, value), deleteProperty: key => props.delete(key)})},
    LockService: {getScriptLock: () => ({waitLock() {assert.equal(locked, false); locked = true;}, releaseLock() {locked = false;}})},
    ss_: () => {sheetReads++; return {};},
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: content => ({setMimeType() {return this;}, getContent: () => content})},
    UrlFetchApp: {fetch(url, options) {
      const key = decodeURIComponent(url.split('/values/')[1]);
      requests.push({key, method: options.method});
      if (options.method === 'put') {
        records.set(key, JSON.parse(options.payload));
        return {getResponseCode: () => 200, getContentText: () => JSON.stringify({success: true, result: {}})};
      }
      return {getResponseCode: () => records.has(key) ? 200 : 404, getContentText: () => JSON.stringify(records.get(key) || {})};
    }}
  });
  vm.runInContext(source, context);
  context.qdpPublicEvents_ = () => {throw new Error('Unpublished sheet data must not be read');};
  return {context, props, records, requests, oldPayload, get sheetReads() {return sheetReads;}};
}

integration('automatic archive refresh stays held while saved changes await explicit publication', () => {
  const h = setup();
  const result = h.context.qdpArchiveAutoRefresh({triggerUid: 'clock'});
  assert.equal(result.held, true);
  assert.equal(JSON.parse(h.props.get('QDP_ARCHIVE_LAST_AUTOMATIC_RUN')).outcome, 'held');
  assert.equal(h.sheetReads, 0);
  assert.equal(h.requests.length, 0);
});

integration('live refresh keeps the previously published snapshot fresh without publishing saved sheet edits', () => {
  const h = setup(), before = JSON.stringify(h.oldPayload);
  assert.equal(h.context.qdpLivePublish({triggerUid: 'clock'}).heartbeat, true);
  assert.equal(JSON.stringify(h.records.get('qdp-live:v1:feed').payload), before);
  assert.ok(Date.now() - Date.parse(h.records.get('qdp-live:v1:feed').publishedAt) < 10000);
  assert.equal(h.sheetReads, 0);
  assert.deepEqual(h.requests.map(r => r.method), ['get', 'put']);
  h.requests.length = 0;
  assert.equal(h.context.qdpLivePublish({triggerUid: 'clock'}).held, true);
  assert.equal(h.requests.length, 0);
});

integration('public fallbacks serve published records while a review is held and never reveal saved edits', () => {
  const h = setup();
  assert.deepEqual(JSON.parse(h.context.doGet({parameter: {resource: 'events'}}).getContent()), h.oldPayload);
  const profile = {profile: {id: 'NEW', name: 'Published artist'}, events: [{eventId: 'OLD'}]};
  const shard = h.context.qdpArchiveShard_('NEW', 4), key = 'artist:' + shard;
  h.records.set('qdp-archive:v1:manifest', {recordIndexVersion: 1, recordRevisions: {[key]: 'published-revision'}});
  h.records.set('qdp-archive:v1:' + key, {revision: 'published-revision', entries: {NEW: profile}});
  assert.deepEqual(plain(h.context.qdpArchiveResource_('archiveartist', {id: 'NEW'})), profile);
  h.records.get('qdp-archive:v1:' + key).revision = 'uncommitted-revision';
  assert.throws(() => h.context.qdpArchiveResource_('archiveartist', {id: 'NEW'}), /temporarily unavailable/);
  h.records.delete('qdp-live:v1:feed');
  assert.match(JSON.parse(h.context.doGet({parameter: {resource: 'events'}}).getContent()).error, /Unable to load/);
  assert.equal(h.sheetReads, 0);
});

integration('only the explicit publishing execution bypasses the hold and its authorization always resets', () => {
  const h = setup();
  h.context.qdpArchivePublishSource_ = () => {throw new Error('Authorized snapshot read');};
  assert.throws(() => h.context.qdpPublicPublishSaved_(() => h.context.qdpArchivePublish()), /Authorized snapshot read/);
  assert.equal(h.sheetReads, 1);
  assert.equal(h.context.qdpPublicArchiveHeld_(), true);
  assert.equal(h.context.qdpArchivePublish().held, true);
  assert.equal(h.sheetReads, 1);
});
