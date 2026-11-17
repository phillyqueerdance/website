import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps-script/ArchiveReview.gs', import.meta.url), 'utf8');
const eventHeaders = ['Status', 'EventID', 'Title (internal)', 'StartDate', 'VenueID',
  'ArtistIDs (comma-separated)', 'Description', 'Location', 'HostCollectiveIDs (comma-separated)',
  'PartyID', 'ExplicitQueer (Yes/No)', 'CalendarColorId', 'QueerArtistIndicator', 'TransArtistIndicator', 'Flyer_URL',
  'Title_Public (auto w/ emojis)', 'LastEditedAt'];
const event = (id, description, fields = {}) => Object.fromEntries(eventHeaders.map(h => [h, ({
  EventID: id, 'Title (internal)': 'Night ' + id, StartDate: '2025-04-01', Description: description,
  ...fields
})[h] || '']));

function setup({ events = [event('ONE', 'Featuring New Artist and The Crew')], active = [], extra = {} } = {}) {
  class Range {
    constructor(sheet, row, col, height = 1, width = 1) {
      Object.assign(this, { sheet, row, col, height, width });
      assert.ok(row > 0 && col > 0 && height > 0 && width > 0, 'Spreadsheet ranges are 1-indexed');
    }
    getValues() { return Array.from({ length: this.height }, (_, i) => Array.from({ length: this.width }, (_, j) =>
      this.sheet.rows[this.row - 1 + i]?.[this.col - 1 + j] ?? '')); }
    getValue() { return this.getValues()[0][0]; }
    setValues(values) {
      assert.equal(values.length, this.height);
      values.forEach((row, i) => {
        assert.equal(row.length, this.width);
        this.sheet.rows[this.row - 1 + i] ||= [];
        row.forEach((value, j) => { this.sheet.rows[this.row - 1 + i][this.col - 1 + j] = value; });
      });
      return this;
    }
    setValue(value) { return this.setValues(Array.from({ length: this.height }, () => Array(this.width).fill(value))); }
    createFilter() { this.sheet.filter = { remove: () => { this.sheet.filter = null; } }; return this; }
  }
  for (const method of ['setBackground', 'setFontColor', 'setFontWeight', 'setNote', 'setNumberFormat', 'setDataValidation']) Range.prototype[method] = function() { return this; };
  class Sheet {
    constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => row.slice()); }
    getName() { return this.name; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    getRange(...args) { return new Range(this, ...args); }
    getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    getFilter() { return this.filter || null; }
    getMaxRows() { return 10000; }
    clear() { this.rows = []; }
    deleteRows(row, count) { this.rows.splice(row - 1, count); }
    setFrozenRows() {} setColumnWidth() {} hideColumns() {} insertRowsAfter() {}
  }
  const rows = records => [eventHeaders, ...records.map(e => eventHeaders.map(h => e[h] || ''))];
  const tables = {
    Artists: [['ArtistID', 'StageName', 'Aliases', 'Instagram', 'Identity_Queer', 'Identity_Trans', 'PublicIdentity_Consent'],
      ['NEW', 'New Artist', '', '@newartist', 'Yes', 'Yes', 'Yes'],
      ['OLD', 'Existing Artist', '', '', 'No', 'No', 'Yes']],
    Venues: [['VenueID', 'VenueName', 'Public_Name', 'Aliases', 'Instagram', 'Address', 'Queer_Venue', 'VenueParties'],
      ['ROOM', 'The Room', 'The Room', '', '', '123 First Street', 'No', 'NIGHT'],
      ['OTHER', 'Other Room', 'Other Room', '', '', '456 Second Street', 'No', '']],
    Parties: [['PartyID', 'PartyName', 'PartyAliases', 'PartyInsta', 'PartyQueer', 'PartyArtists', 'PartyVenues'],
      ['NIGHT', 'The Night', '', '', 'No', 'NEW', 'ROOM']],
    Collectives: [['CollectiveID', 'CollectiveName', 'Aliases', 'CollInsta'], ['CREW', 'The Crew', '', '']],
    Events_Archive: rows(events), Events: rows(active), ...extra
  };
  const sheets = new Map(Object.entries(tables).map(([name, data]) => [name, new Sheet(name, data)]));
  const ss = { getSheetByName: name => sheets.get(name), getSheets: () => [...sheets.values()],
    insertSheet: name => { const sheet = new Sheet(name); sheets.set(name, sheet); return sheet; }, toast() {} };
  const props = new Map(), triggers = [], publishes = [];
  const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}@]+/gu, ' ').trim();
  const references = kind => {
    const spec = { artist: ['Artists', 'ArtistID', 'StageName'], venue: ['Venues', 'VenueID', 'Public_Name'], party: ['Parties', 'PartyID', 'PartyName'], collective: ['Collectives', 'CollectiveID', 'CollectiveName'] }[kind];
    const table = sheets.get(spec[0]).rows, h = table[0];
    return table.slice(1).map(r => ({ id: r[h.indexOf(spec[1])], name: r[h.indexOf(spec[2])] }));
  };
  const core = () => {
    const out = {};
    for (const [kind, directory, aliases] of [['artist', 'artistById', 'artistAliases'], ['venue', 'venueById', 'venueAliases'],
      ['party', 'partyById', 'partyAliases'], ['collective', 'collById', 'collAliases']]) {
      out[directory] = {}; out[aliases] = [];
      for (const p of references(kind)) {
        out[directory][p.id] = { name: p.name, stage: p.name, queer: kind === 'artist' && p.id === 'NEW', trans: kind === 'artist' && p.id === 'NEW', consent: true };
        out[aliases].push({ id: p.id, key: normalize(p.name), exactOnly: false });
      }
    }
    return out;
  };
  let locked = false;
  const lock = { waitLock() { assert.equal(locked, false, 'No nested Script locks'); locked = true; },
    tryLock() { if (locked) return false; locked = true; return true; }, releaseLock() { assert.equal(locked, true); locked = false; } };
  const c = vm.createContext({ Date, Map, Set, JSON, String, Object, Array, RegExp, Math, Number, console,
    CONFIG: { SHEET_EVENTS: 'Events' },
    ss_: () => ss, LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) || null,
      setProperty: (key, value) => props.set(key, value), deleteProperty: key => props.delete(key) }) },
    Utilities: { getUuid: randomUUID, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, text) => createHash('sha256').update(text).digest(),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      formatDate: (date, zone, format) => format === 'yyyy-MM-dd' ? new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(date) : date.toISOString() },
    SpreadsheetApp: { newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }), flush() {} },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() { const trigger = { getHandlerFunction: () => handler }; triggers.push(trigger); return trigger; } }) },
    qdpAdminListArtists_: () => references('artist'),
    qdpAdminListIndexProfiles_: kind => {
      if (kind === 'artist') throw new Error('Choose Venues, Parties, or Collectives.');
      return references(kind);
    }, buildLookupMaps_: core,
    normalizeKey_: normalize, fixMojibake_: text => text,
    qdpAliasMatches_: (alias, text) => alias.exactOnly ? new RegExp('(?:^| )' + alias.key + '(?=$| )').test(text) : text.includes(alias.key),
    qdpArchiveIds_: text => [...new Set(String(text || '').split(',').map(x => x.trim()).filter(Boolean))],
    computeArtistIndicators_: (ids, lookups, partyId) => ({ hasQueer: ids.some(id => lookups.artistById[id]?.queer) || lookups.partyById?.[partyId]?.qArtistAlways,
      hasTrans: ids.some(id => lookups.artistById[id]?.trans) || lookups.partyById?.[partyId]?.tArtistAlways }),
    qdpArchiveLink_: value => /^https?:/.test(value) ? value : '',
    qdpLivePublish: () => { assert.equal(locked, false); publishes.push('live'); },
    qdpArchivePublish: () => { assert.equal(locked, false); publishes.push('archive'); }
  });
  vm.runInContext(source, c);
  // Optional integration pass against the full user-maintained Core.gs.
  if (process.env.QDP_CORE_SOURCE) {
    vm.runInContext(readFileSync(process.env.QDP_CORE_SOURCE, 'utf8'), c);
    c.ss_ = () => ss;
  }
  const call = (action, data = {}) => c.qdpAdminArchive_({ action: 'admin.archive.' + action, ...data });
  const plain = value => JSON.parse(JSON.stringify(value));
  const proposals = page => page.events.flatMap(e => e.proposals);
  const approve = page => call('decide', { changes: proposals(page).filter(p => p.state === 'pending' && p.kind === 'artist')
    .map(p => ({ key: p.key, revision: p.revision, decision: 'Approve', proposedIds: p.proposedIds })) });
  const finish = () => { for (let i = 0; i < 30; i++) { const page = call('bootstrap'); if (!c.qdpArchiveAdminActive_(page.job)) return page; c.qdpArchiveAdminWorker(); } throw new Error('Job did not finish'); };
  return { c, ss, sheets, props, triggers, publishes, call, plain, proposals, approve, finish, rows };
}

test('initial page load gets artists from the artist loader and includes every profile type', () => {
  const h = setup();
  assert.throws(() => h.c.qdpAdminListIndexProfiles_('artist'), /Choose Venues, Parties, or Collectives/);
  const page = h.call('bootstrap', { references: true });
  assert.deepEqual(Object.keys(page.references), ['artist', 'venue', 'party', 'collective']);
  assert.ok(page.references.artist.some(p => p.id === 'NEW' && p.name === 'New Artist'));
  for (const [kind, id] of [['venue', 'ROOM'], ['party', 'NIGHT'], ['collective', 'CREW']]) {
    assert.ok(page.references[kind].some(p => p.id === id));
  }
  assert.equal(page.scanInProgress, false);
  assert.equal(page.job, null);
});

test('a focused artist scan validates the artist using the dedicated artist loader', () => {
  const h = setup();
  assert.throws(() => h.call('scan', {kind: 'artist', profileId: 'MISSING'}), /no longer in the Index/);
  const page = h.call('scan', {kind: 'artist', profileId: 'NEW'});
  assert.ok(h.proposals(page).some(p => p.kind === 'artist' && p.proposedIds.includes('NEW')));
});

test('a newly added artist is proposed on old records without replacing existing assignments', () => {
  const h = setup({ events: [event('ONE', 'The Night featuring New Artist and The Crew at The Room', {
    VenueID: 'OTHER', PartyID: 'EXISTING-PARTY', 'ArtistIDs (comma-separated)': 'OLD', Flyer_URL: 'https://example.com/flyer.jpg'
  })] });
  const page = h.call('scan');
  assert.equal(page.scan.scanned, 1);
  const additions = h.proposals(page);
  const artist = additions.find(p => p.kind === 'artist');
  assert.deepEqual(h.plain(artist.proposedIds), ['OLD', 'NEW']);
  assert.equal(additions.some(p => ['venue', 'party'].includes(p.kind)), false);
  assert.equal(page.events[0].flyerUrl, 'https://example.com/flyer.jpg');
  assert.match(artist.evidence, /New Artist/);
});

test('profile affiliations never stand in for an event lineup or venue', () => {
  const h = setup({ events: [event('ONE', 'The Night')] });
  const proposals = h.proposals(h.call('scan'));
  assert.equal(proposals.some(p => ['artist', 'venue'].includes(p.kind)), false);
  assert.equal(proposals.some(p => p.kind === 'party'), true);
});

test('focused date scans include year archives and active recorded events while ignoring cancellations', () => {
  const h = setup({ events: [event('TOO-EARLY', 'New Artist', { StartDate: '2024-01-01' })],
    active: [event('ACTIVE', 'New Artist and The Crew')],
    extra: { 'Archive 2027': [eventHeaders, ...[event('YEAR', 'New Artist'), event('CANCELLED', 'New Artist', { Status: 'Cancelled' })].map(e => eventHeaders.map(k => e[k]))] } });
  const page = h.call('scan', { includeActive: true, kind: 'artist', profileId: 'NEW', from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(h.plain(page.events.map(e => e.eventId)).sort(), ['ACTIVE', 'YEAR']);
  assert.ok(h.proposals(page).every(p => p.kind === 'artist'));
  assert.throws(() => h.call('scan', { from: '2025-02-30', replaceReview: true }), /valid date/);
});

test('saved rejections survive a full rescan and can be restored by their stable identity', () => {
  const h = setup();
  const artist = h.proposals(h.call('scan')).find(p => p.kind === 'artist');
  h.call('decide', { changes: [{ key: artist.key, revision: artist.revision, decision: 'Reject' }] });
  assert.equal(h.call('rejects').rejectedTotal, 1);
  const page = h.call('scan', { replaceReview: true });
  assert.equal(h.proposals(page).some(p => p.kind === 'artist'), false);
  h.call('restore', { key: h.call('rejects').rejects[0].key });
  assert.equal(h.call('rejects').rejectedTotal, 0);
  assert.equal(h.proposals(h.call('scan', { replaceReview: true })).some(p => p.kind === 'artist'), true);
});

test('an incorrect suggestion can be rejected even if an old ID needs cleanup or the Index has changed', () => {
  const h = setup({events: [event('ONE', 'New Artist', {'ArtistIDs (comma-separated)': 'UNKNOWN'})]});
  const suggestion = h.proposals(h.call('scan'))[0];
  assert.equal(suggestion.state, 'blocked');
  h.sheets.get('Artists').rows[1][1] = 'Edited after scanning';
  h.call('decide', {changes: [{key: suggestion.key, revision: suggestion.revision, decision: 'Reject'}]});
  assert.equal(h.call('rejects').rejectedTotal, 1);
});

test('changes to active recorded events receive the Calendar sync edit timestamp', () => {
  const h = setup({events: [], active: [event('ACTIVE', 'New Artist')]});
  h.approve(h.call('scan', {includeActive: true})); h.call('apply'); h.finish();
  const row = h.sheets.get('Events').rows[1];
  assert.equal(row[eventHeaders.indexOf('ArtistIDs (comma-separated)')], 'NEW');
  assert.ok(Date.parse(row[eventHeaders.indexOf('LastEditedAt')]));
});

test('review revisions reject a stale batch before any decisions are saved', () => {
  const h = setup();
  const proposals = h.proposals(h.call('scan'));
  const before = JSON.stringify(h.sheets.get('Archive_ID_Review').rows);
  assert.throws(() => h.call('decide', { changes: proposals.map((p, i) => ({ key: p.key,
    revision: i ? 'stale' : p.revision, decision: 'Approve', proposedIds: p.proposedIds })) }), /review changed/);
  assert.equal(JSON.stringify(h.sheets.get('Archive_ID_Review').rows), before);
});

test('apply resolves events by identity after row movement, preserves old IDs and publishes only after saving', () => {
  const h = setup({ events: [event('ONE', 'New Artist', { 'ArtistIDs (comma-separated)': 'OLD' }), event('TWO', 'No one matched')] });
  h.approve(h.call('scan'));
  const table = h.sheets.get('Events_Archive').rows;
  [table[1], table[2]] = [table[2], table[1]];
  h.call('apply');
  const page = h.finish();
  assert.equal(table[2][eventHeaders.indexOf('ArtistIDs (comma-separated)')], 'OLD, NEW');
  assert.equal(table[2][eventHeaders.indexOf('QueerArtistIndicator')], 'Yes');
  assert.equal(page.summary.applied, 1);
  assert.deepEqual(h.publishes, ['live', 'archive']);
  assert.equal(page.needsPublish, false);
  assert.equal(h.triggers.length, 0);
});

test('changed source records and duplicate EventIDs block writes instead of overwriting them', () => {
  for (const duplicate of [false, true]) {
    const h = setup({ events: [event('ONE', 'New Artist')] });
    h.approve(h.call('scan'));
    const sheet = h.sheets.get('Events_Archive');
    if (duplicate) sheet.rows.push(sheet.rows[1].slice());
    else sheet.rows[1][eventHeaders.indexOf('Description')] = 'Edited after the scan';
    h.call('apply');
    const result = h.finish();
    assert.equal(sheet.rows[1][eventHeaders.indexOf('ArtistIDs (comma-separated)')], '');
    assert.equal(result.summary.blocked, 1);
  }
});

test('a failed archive publish retains the dirty marker and retries without applying the additions twice', () => {
  const h = setup({ events: [event('ONE', 'New Artist')] });
  h.approve(h.call('scan')); h.call('apply');
  h.c.qdpArchivePublish = () => { throw new Error('Temporary publish failure'); };
  const failure = h.finish();
  assert.equal(failure.job.phase, 'failed');
  assert.equal(failure.needsPublish, true);
  assert.match(failure.job.error, /Temporary publish failure/);
  h.c.qdpArchivePublish = () => h.publishes.push('archive');
  h.call('retry');
  const done = h.finish();
  assert.equal(done.needsPublish, false);
  assert.equal(done.summary.applied, 1);
  assert.deepEqual(h.publishes, ['live', 'archive']);
});

test('large scans resume from durable progress and share one temporary trigger', () => {
  const h = setup({ events: Array.from({ length: 560 }, (_, i) => event('E-' + i, 'New Artist')) });
  const first = h.call('scan');
  assert.equal(first.scan.scanned, 250);
  assert.equal(first.scanInProgress, true);
  assert.equal(h.triggers.length, 1);
  assert.throws(() => h.call('scan'), /Wait for the current/);
  const done = h.finish();
  assert.equal(done.scan.scanned, 560);
  assert.equal(done.scanInProgress, false);
  assert.equal(done.totalEvents, 560);
  assert.equal(h.triggers.length, 0);
});

test('an Index edit invalidates uncommitted decisions and writes no archive cells', () => {
  const h = setup();
  const page = h.call('scan');
  h.sheets.get('Artists').rows[1][1] = 'Renamed Artist';
  assert.throws(() => h.approve(page), /Index changed/);
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('ArtistIDs (comma-separated)')], '');
});

test('Core integration: archive matching keeps DJ Love separate and honors bracketed aliases', {skip: !process.env.QDP_CORE_SOURCE}, () => {
  const h = setup({events: [event('ONE', 'DJ Love Letters with Spicy and Bassline'), event('TWO', 'DJ Love with Sp and Bass')]});
  h.sheets.get('Artists').rows.push(
    ['LOVE', 'DJ Love', '', '', 'Yes', 'No', 'Yes'],
    ['LETTERS', 'DJ Love Letters', '', '', 'Yes', 'No', 'Yes'],
    ['SHORT', 'Sp', '[Sp]', '', 'Yes', 'No', 'Yes'],
    ['EXACT', 'Bass', '[Bass]', '', 'Yes', 'No', 'Yes']
  );
  const page = h.call('scan', {kind: 'artist'});
  const ids = id => h.plain(page.events.find(e => e.eventId === id).proposals[0].proposedIds);
  assert.deepEqual(ids('ONE'), ['LETTERS']);
  assert.deepEqual(ids('TWO'), ['LOVE', 'EXACT', 'SHORT']);
});
