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

function setup({ events = [event('ONE', 'Featuring New Artist and The Crew')], active = [], extra = {}, staleReads = false } = {}) {
  let nextSheetId = 1;
  const batchRequests = [], reads = [], snapshots = new Map();
  let digestCount = 0;
  class Range {
    constructor(sheet, row, col, height = 1, width = 1) {
      Object.assign(this, { sheet, row, col, height, width });
      assert.ok(row > 0 && col > 0 && height > 0 && width > 0, 'Spreadsheet ranges are 1-indexed');
    }
    getValues() {
      reads.push({sheet: this.sheet.name, row: this.row, height: this.height, width: this.width});
      if (staleReads && !snapshots.has(this.sheet.name)) snapshots.set(this.sheet.name, this.sheet.rows.map(row => row.slice()));
      const values = staleReads ? snapshots.get(this.sheet.name) : this.sheet.rows;
      return Array.from({ length: this.height }, (_, i) => Array.from({ length: this.width }, (_, j) =>
        values[this.row - 1 + i]?.[this.col - 1 + j] ?? ''));
    }
    getValue() { return this.getValues()[0][0]; }
    getFormulas() { return Array.from({length: this.height}, (_, i) => Array.from({length: this.width}, (_, j) =>
      this.sheet.formulas?.[this.row - 1 + i]?.[this.col - 1 + j] || '')); }
    setValues(values) {
      snapshots.delete(this.sheet.name);
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
    constructor(name, rows = []) { this.name = name; this.id = nextSheetId++; this.rows = rows.map(row => row.slice()); }
    getName() { return this.name; }
    getSheetId() { return this.id; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    getRange(...args) { return new Range(this, ...args); }
    getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    getFilter() { return this.filter || null; }
    getMaxRows() { return 10000; }
    clear() { this.rows = []; snapshots.delete(this.name); }
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
  const ss = { getId: () => 'qdp-index', getSheetByName: name => sheets.get(name), getSheets: () => [...sheets.values()],
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
      computeDigest: (_, text) => { digestCount++; return createHash('sha256').update(text).digest(); },
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      formatDate: (date, zone, format) => format === 'yyyy-MM-dd' ? new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(date) : date.toISOString() },
    SpreadsheetApp: { newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }), flush() {} },
    Sheets: { Spreadsheets: { batchUpdate(body, spreadsheetId) {
      assert.equal(spreadsheetId, 'qdp-index');
      const prepared = body.requests.map(request => {
        const update = request.updateCells || request.appendCells;
        const sheet = [...sheets.values()].find(sheet => sheet.getSheetId() === (update.start?.sheetId ?? update.sheetId));
        assert.ok(sheet);
        if (request.appendCells) return {sheet, append: update.rows.map(row => row.values.map(cell => cell.userEnteredValue.stringValue))};
        assert.equal(update.rows.length, 1);
        assert.equal(update.rows[0].values.length, 1);
        return { sheet, row: update.start.rowIndex, column: update.start.columnIndex,
          value: update.rows[0].values[0].userEnteredValue.stringValue };
      });
      batchRequests.push(body.requests);
      for (const cell of prepared) {
        if (cell.append) cell.sheet.rows.push(...cell.append);
        else cell.sheet.rows[cell.row][cell.column] = cell.value;
      }
    } } },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() { const trigger = { getHandlerFunction: () => handler }; triggers.push(trigger); return trigger; } }) },
    qdpAdminListArtists_: () => references('artist'),
    qdpPublicSheet_: (reads, name) => reads.sheets.get(name),
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
    qdpPublicPublishSaved_: callback => callback(),
    qdpArchivePublish: () => { assert.equal(locked, false); publishes.push('archive'); }
  });
  vm.runInContext(source, c);
  // Optional integration pass against the full user-maintained Core.gs.
  if (process.env.QDP_CORE_SOURCE) {
    vm.runInContext(readFileSync(process.env.QDP_CORE_SOURCE, 'utf8'), c);
    c.ss_ = () => ss;
  }
  const call = (action, data = {}) => { snapshots.clear(); return c.qdpAdminArchive_({ action: 'admin.archive.' + action, ...data }); };
  const plain = value => JSON.parse(JSON.stringify(value));
  const proposals = page => page.events.flatMap(e => e.proposals);
  const approve = page => call('decide', { changes: proposals(page).filter(p => p.state === 'pending' && p.kind === 'artist')
    .map(p => ({ key: p.key, revision: p.revision, decision: 'Approve', proposedIds: p.proposedIds })) });
  const finish = () => { for (let i = 0; i < 30; i++) { const page = call('bootstrap'); if (!c.qdpArchiveAdminActive_(page.job)) return page; c.qdpArchiveAdminWorker(); } throw new Error('Job did not finish'); };
  return { c, ss, sheets, props, triggers, publishes, batchRequests, reads, get digestCount() { return digestCount; }, call, plain, proposals, approve, finish, rows };
}

test('checked revisions and rejections save together; unchecked suggestions remain pending', () => {
  const h = setup({events: [event('ONE', 'New Artist and The Crew'), event('TWO', 'New Artist')]});
  const page = h.call('scan');
  const artist = page.events[0].proposals.find(p => p.kind === 'artist');
  const collective = page.events[0].proposals.find(p => p.kind === 'collective');
  const saved = h.call('save', {changes: [
    {key: artist.key, revision: artist.revision, decision: 'Approve', proposedIds: artist.proposedIds},
    {key: collective.key, revision: collective.revision, decision: 'Reject'}
  ]});
  assert.equal(saved.saved, 2);
  assert.equal(saved.savedKeys.length, 2);
  assert.equal(saved.job.phase, 'saved');
  const done = h.finish();
  assert.deepEqual(h.plain(done.summary), {pending: 1, approved: 0, applied: 1, rejected: 1, blocked: 0});
  assert.equal(h.sheets.get('Events_Archive').rows[2][eventHeaders.indexOf('ArtistIDs (comma-separated)')], '');
  assert.equal(h.call('rejects').rejectedTotal, 1);
  assert.deepEqual(h.publishes, []);
  assert.equal(done.needsPublish, true);
  h.call('publish');
  assert.equal(h.finish().needsPublish, false);
  assert.deepEqual(h.publishes, ['live', 'archive']);
});

test('all decisions and all archive cell updates use batch requests rather than a write per change', () => {
  const h = setup({events: Array.from({length: 125}, (_, i) => event('E-' + i, 'New Artist'))});
  const page = h.call('scan');
  const changes = h.sheets.get('Archive_ID_Review').rows.slice(1).map(row => ({
    key: h.c.qdpArchiveAdminKey_(row), revision: h.c.qdpArchiveAdminRevision_(row), decision: 'Approve', proposedIds: ['NEW']
  }));
  h.call('save', {changes});
  assert.equal(h.batchRequests.length, 2);
  assert.equal(h.batchRequests[0].length, 250);
  h.c.qdpArchiveAdminWorker();
  assert.equal(h.batchRequests.length, 2);
  assert.equal(h.batchRequests[1].length, 500); // ID, result, and two indicator cells for each event.
  assert.equal(h.finish().summary.applied, 125);
});

test('rejection-only batches stay saved without publishing or applying unchecked suggestions', () => {
  const h = setup();
  const artist = h.proposals(h.call('scan')).find(p => p.kind === 'artist');
  const result = h.call('save', {changes: [{key: artist.key, revision: artist.revision, decision: 'Reject'}]});
  assert.equal(result.summary.rejected, 1);
  assert.equal(result.summary.pending, 1);
  assert.equal(result.job.phase, 'saved');
  assert.equal(h.triggers.length, 0);
  assert.deepEqual(h.publishes, []);
});

test('rejections are committed atomically even when SpreadsheetApp reads stay cached after API writes', () => {
  const h = setup({staleReads: true});
  h.c.ss_ = () => ({...h.ss}); // Apps Script may return a new handle for the same workbook.
  const page = h.call('scan');
  const result = h.call('save', {includeRejects: true, changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision,
    decision: p.kind === 'artist' ? 'Approve' : 'Reject', proposedIds: p.proposedIds}))});
  assert.equal(result.summary.applied, 1);
  assert.equal(result.summary.rejected, 1);
  assert.equal(result.rejectedTotal, 1);
  assert.equal(result.unsavedRejectCount, 0);
  assert.equal(result.rejects[0].value, 'CREW');
  assert.ok(h.batchRequests[0].some(request => request.appendCells));
  assert.ok(h.batchRequests[0].some(request => request.updateCells?.rows[0].values[0].userEnteredValue.stringValue === 'Rejected (saved)'));
  assert.equal(h.call('rejects').rejectedTotal, 1);
  assert.deepEqual(h.publishes, []);
});

test('a rejected batch failure confirms nothing and writes neither decisions nor permanent rejections', () => {
  const h = setup(), page = h.call('scan');
  h.c.Sheets.Spreadsheets.batchUpdate = () => { throw new Error('Sheets unavailable'); };
  assert.throws(() => h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision, decision: 'Reject'}))}), /Sheets unavailable/);
  assert.ok(h.sheets.get('Archive_ID_Review').rows.slice(1).every(row => row[0] === 'Pending'));
  assert.equal(h.call('rejects').rejectedTotal, 0);
});

test('Save all repairs older unsaved Reject decisions and immediately updates an open rejection list', () => {
  const h = setup(), page = h.call('scan');
  h.sheets.get('Archive_ID_Review').rows[1][0] = 'Reject';
  assert.equal(h.call('bootstrap').unsavedRejectCount, 1);
  const saved = h.call('save', {changes: [], includeRejects: true});
  assert.equal(saved.saved, 1);
  assert.equal(saved.rejectedTotal, 1);
  const restored = h.call('restore', {key: saved.rejects[0].key, includeRejects: true});
  assert.equal(restored.rejectedTotal, 0);
  assert.deepEqual(h.publishes, []);
});

test('saving does not require publication helpers, and upgrading a queued legacy publish stops it', () => {
  const h = setup(), page = h.call('scan');
  h.c.qdpLivePublish = h.c.qdpArchivePublish = undefined;
  const saved = h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision,
    decision: 'Approve', proposedIds: p.proposedIds}))});
  assert.equal(saved.job.phase, 'saved');
  assert.throws(() => h.call('publish'), /PublicData.gs/);
  for (const phase of ['publishing-live', 'publishing-archive']) {
    // Use the configured key rather than coupling the fixture to its spelling.
    vm.runInContext(`PropertiesService.getScriptProperties().setProperty(QDP_ARCHIVE_ADMIN_.jobKey, JSON.stringify({run:'legacy',phase:'${phase}'}))`, h.c);
    h.c.qdpArchiveAdminWorker();
    assert.equal(h.call('bootstrap').job.phase, 'saved');
  }
});

test('a partial upgrade with the older scheduled publishers cannot write decisions or event edits', () => {
  const h = setup(), page = h.call('scan');
  h.c.qdpPublicPublishSaved_ = undefined;
  assert.equal(h.call('bootstrap').separatePublish, false);
  assert.throws(() => h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision,
    decision: 'Approve', proposedIds: p.proposedIds}))}), /PublicData.gs v7.4.22/);
  assert.equal(h.batchRequests.length, 0);
});

test('large saves continue in batches but never queue publication', () => {
  const h = setup({events: Array.from({length: 210}, (_, i) => event('E-' + i, 'New Artist'))});
  h.call('scan');
  const changes = h.sheets.get('Archive_ID_Review').rows.slice(1).map(row => ({key: h.c.qdpArchiveAdminKey_(row),
    revision: h.c.qdpArchiveAdminRevision_(row), decision: 'Approve', proposedIds: ['NEW']}));
  const saved = h.call('save', {changes});
  assert.equal(saved.job.phase, 'applying');
  assert.equal(saved.summary.applied, 200);
  const done = h.finish();
  assert.equal(done.job.phase, 'saved');
  assert.equal(done.summary.applied, 210);
  assert.equal(done.needsPublish, true);
  assert.deepEqual(h.publishes, []);
  assert.equal(h.triggers.length, 0);
});

test('scan progress avoids rereading the growing review or rebuilding results, and lookup tables are read once per batch', () => {
  const h = setup({events: Array.from({length: 2360}, (_, i) => event('E-' + i, 'New Artist'))});
  h.call('scan'); h.reads.length = 0;
  const step = h.call('step', {progressOnly: true});
  assert.equal(step.progressOnly, true);
  assert.equal(step.events, undefined);
  assert.equal(step.scan.scanned, 2000);
  assert.equal(h.reads.filter(read => read.sheet === 'Archive_ID_Review' && read.row > 1).length, 0);
  for (const name of ['Artists', 'Venues', 'Parties', 'Collectives']) assert.equal(h.reads.filter(read => read.sheet === name).length, 1, name);
  h.finish();
  const before = h.digestCount, page = h.call('bootstrap');
  assert.equal(page.totalEvents, 2360);
  assert.equal(h.digestCount - before, page.events.flatMap(e => e.proposals).length * 2);
});

test('event edit links open Admin using stable EventID and source tab after records move', () => {
  const h = setup({events: [event('ONE', 'New Artist'), event('TWO', 'No match')]});
  h.call('scan');
  const sheet = h.sheets.get('Events_Archive');
  [sheet.rows[1], sheet.rows[2]] = [sheet.rows[2], sheet.rows[1]];
  assert.equal(h.call('bootstrap').events[0].editUrl,
    '/admin/event.html?eventId=ONE&sheet=Events_Archive');
});

test('review results include the full original description without truncating or stripping line breaks', () => {
  const description = 'New Artist\n\n' + 'Full recorded event copy. '.repeat(90) + '\nLast line of the event.';
  const h = setup({events: [event('ONE', description)]});
  assert.equal(h.call('scan').events[0].description, description);
});

test('Admin event editor saves a historical description to its original source without touching Events', () => {
  const h = setup({active: [event('ONE', 'Current event stays separate')]});
  const source = {eventId: 'ONE', sheet: 'Events_Archive'};
  const loaded = h.call('event.read', source);
  assert.equal(loaded.event.fields.find(field => field.key === 'Description').value, 'Featuring New Artist and The Crew');
  const saved = h.call('event.save', {...source, expectedRevision: loaded.event.revision, fields: {Description: 'Updated\n\nFull description'}});
  assert.equal(saved.event.fields.find(field => field.key === 'Description').value, 'Updated\n\nFull description');
  assert.notEqual(saved.event.revision, loaded.event.revision);
  assert.equal(h.sheets.get('Events').rows[1][eventHeaders.indexOf('Description')], 'Current event stays separate');
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('LastEditedAt')], '');
  assert.equal(saved.needsPublish, true);
  assert.equal(h.batchRequests.length, 1);
});

test('event editor follows row movement and rejects stale, missing, or duplicated records before writing', () => {
  for (const mode of ['moved', 'changed', 'missing', 'duplicate']) {
    const h = setup({events: [event('ONE', 'Original description'), event('TWO', 'Other event')]});
    const source = {eventId: 'ONE', sheet: 'Events_Archive'};
    const loaded = h.call('event.read', source), sheet = h.sheets.get(source.sheet);
    if (mode === 'moved') [sheet.rows[1], sheet.rows[2]] = [sheet.rows[2], sheet.rows[1]];
    if (mode === 'changed') sheet.rows[1][eventHeaders.indexOf('Description')] = 'External edit';
    if (mode === 'missing') sheet.rows.splice(1, 1);
    if (mode === 'duplicate') sheet.rows.push(sheet.rows[1].slice());
    const save = () => h.call('event.save', {...source, expectedRevision: loaded.event.revision, fields: {Description: 'My edit'}});
    if (mode === 'moved') {
      save(); assert.equal(sheet.rows[2][eventHeaders.indexOf('Description')], 'My edit');
      assert.equal(sheet.rows[1][eventHeaders.indexOf('Description')], 'Other event');
    } else { assert.throws(save, /changed|no longer|duplicated/); assert.equal(h.batchRequests.length, 0); }
  }
});

test('event editor protects formulas and system fields and preserves unrelated archive data', () => {
  const h = setup();
  const source = {eventId: 'ONE', sheet: 'Events_Archive'}, sheet = h.sheets.get(source.sheet);
  sheet.formulas = []; sheet.formulas[1] = []; sheet.formulas[1][eventHeaders.indexOf('Title_Public (auto w/ emojis)')] = '=A2';
  const loaded = h.call('event.read', source);
  assert.equal(loaded.event.fields.find(f => f.key === 'Title_Public (auto w/ emojis)').readOnly, true);
  for (const fields of [{EventID: 'OTHER'}, {'Title_Public (auto w/ emojis)': 'Overwrite formula'}, {CalendarEventId: 'other-calendar-id'}]) {
    assert.throws(() => h.call('event.save', {...source, expectedRevision: loaded.event.revision, fields}), /cannot be edited/);
  }
  assert.equal(h.batchRequests.length, 0);
  h.call('event.save', {...source, expectedRevision: loaded.event.revision, fields: {'ArtistIDs (comma-separated)': 'NEW'}});
  assert.equal(sheet.formulas[1][eventHeaders.indexOf('Title_Public (auto w/ emojis)')], '=A2');
  assert.equal(sheet.rows[1][eventHeaders.indexOf('QueerArtistIndicator')], 'Yes');
  assert.equal(sheet.rows[1][eventHeaders.indexOf('TransArtistIndicator')], 'Yes');
  assert.equal(sheet.rows[1][eventHeaders.indexOf('Description')], 'Featuring New Artist and The Crew');
});

test('event editor rejects new unknown IDs, non-event tabs, and invalid links before writing', () => {
  const h = setup(), source = {eventId: 'ONE', sheet: 'Events_Archive'};
  const loaded = h.call('event.read', source);
  for (const fields of [{'ArtistIDs (comma-separated)': 'MISSING'}, {Flyer_URL: 'javascript:alert(1)'}]) {
    assert.throws(() => h.call('event.save', {...source, expectedRevision: loaded.event.revision, fields}), /Unknown|HTTP or HTTPS/);
  }
  assert.throws(() => h.call('event.read', {sheet: 'Artists', eventId: 'NEW'}), /recorded event/);
  assert.equal(h.batchRequests.length, 0);
});

test('editing active Events marks the record for Calendar sync and never writes Calendar directly', () => {
  const h = setup({active: [event('ACTIVE', 'Original')]});
  const source = {eventId: 'ACTIVE', sheet: 'Events'}, loaded = h.call('event.read', source);
  h.call('event.save', {...source, expectedRevision: loaded.event.revision, fields: {Description: 'Updated'}});
  assert.ok(Date.parse(h.sheets.get('Events').rows[1][eventHeaders.indexOf('LastEditedAt')]));
  assert.deepEqual(h.publishes, []);
});

test('a stale checked revision prevents the entire save before any decisions are written', () => {
  const h = setup();
  const page = h.call('scan');
  const before = JSON.stringify(h.sheets.get('Archive_ID_Review').rows);
  const changes = h.proposals(page).map((p, i) => ({key: p.key, revision: i ? 'stale' : p.revision,
    decision: 'Approve', proposedIds: p.proposedIds}));
  assert.throws(() => h.call('save', {changes}), /review changed/);
  assert.equal(JSON.stringify(h.sheets.get('Archive_ID_Review').rows), before);
  assert.equal(h.batchRequests.length, 0);
  assert.equal(h.triggers.length, 0);
});

test('new batch saves require Sheets service before writing; the older menu still works', () => {
  const h = setup();
  const page = h.call('scan');
  const artist = h.proposals(page).find(p => p.kind === 'artist');
  h.c.Sheets = undefined;
  assert.throws(() => h.call('save', {changes: [{key: artist.key, revision: artist.revision,
    decision: 'Approve', proposedIds: artist.proposedIds}]}), /Enable Google Sheets API/);
  h.approve(page);
  assert.equal(h.c.qdpApplyApprovedArchiveIds().applied, 1);
});

test('a failed archive batch writes no partial event edits and resumes safely', () => {
  const h = setup({events: [event('ONE', 'New Artist'), event('TWO', 'New Artist')]});
  const page = h.call('scan');
  const batchUpdate = h.c.Sheets.Spreadsheets.batchUpdate;
  h.c.Sheets.Spreadsheets.batchUpdate = (...args) => {
    if (h.batchRequests.length) throw new Error('Temporary Sheets outage');
    return batchUpdate(...args);
  };
  const response = h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision,
    decision: 'Approve', proposedIds: p.proposedIds}))});
  assert.equal(response.savedKeys.length, 2);
  assert.equal(h.finish().job.phase, 'failed');
  assert.ok(h.sheets.get('Events_Archive').rows.slice(1).every(row => row[eventHeaders.indexOf('ArtistIDs (comma-separated)')] === ''));
  assert.deepEqual(h.publishes, []);
  h.c.Sheets.Spreadsheets.batchUpdate = batchUpdate;
  h.call('retry');
  assert.equal(h.finish().summary.applied, 2);
  assert.deepEqual(h.publishes, []);
});

test('queer classification can depend on a venue approved in the same atomic batch', () => {
  const h = setup({events: [event('ONE', 'The Room')]});
  h.sheets.get('Venues').rows[1][6] = 'Yes';
  const page = h.call('scan');
  assert.ok(h.proposals(page).some(p => p.kind === 'classification'));
  h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision,
    decision: 'Approve', proposedIds: p.proposedIds}))});
  assert.equal(h.finish().summary.applied, 2);
  const row = h.sheets.get('Events_Archive').rows[1];
  assert.equal(row[eventHeaders.indexOf('VenueID')], 'ROOM');
  assert.equal(row[eventHeaders.indexOf('ExplicitQueer (Yes/No)')], 'Yes');
});

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

test('apply resolves events by identity after row movement, preserves old IDs and waits for explicit publishing', () => {
  const h = setup({ events: [event('ONE', 'New Artist', { 'ArtistIDs (comma-separated)': 'OLD' }), event('TWO', 'No one matched')] });
  h.approve(h.call('scan'));
  const table = h.sheets.get('Events_Archive').rows;
  [table[1], table[2]] = [table[2], table[1]];
  h.call('apply');
  const page = h.finish();
  assert.equal(table[2][eventHeaders.indexOf('ArtistIDs (comma-separated)')], 'OLD, NEW');
  assert.equal(table[2][eventHeaders.indexOf('QueerArtistIndicator')], 'Yes');
  assert.equal(page.summary.applied, 1);
  assert.deepEqual(h.publishes, []);
  assert.equal(page.needsPublish, true);
  h.call('publish');
  assert.equal(h.finish().needsPublish, false);
  assert.deepEqual(h.publishes, ['live', 'archive']);
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
  h.approve(h.call('scan')); h.call('apply'); h.finish(); h.call('publish');
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

test('large scans can restart immediately from row one and share one temporary trigger', () => {
  const h = setup({ events: Array.from({ length: 2360 }, (_, i) => event('E-' + i, 'New Artist')) });
  const first = h.call('scan');
  assert.equal(first.scan.scanned, 1000);
  assert.equal(first.scanInProgress, true);
  assert.equal(h.triggers.length, 1);
  const restarted = h.call('scan');
  assert.notEqual(restarted.job.run, first.job.run);
  assert.equal(restarted.scan.scanned, 1000);
  assert.equal(h.sheets.get('Archive_ID_Review').rows.length, 1001);
  assert.equal(h.triggers.length, 1);
  const done = h.finish();
  assert.equal(done.scan.scanned, 2360);
  assert.equal(done.scanInProgress, false);
  assert.equal(done.totalEvents, 2360);
  assert.equal(h.triggers.length, 0);
});

test('a fresh scan discards unsaved approvals and valid or invalid rejects while keeping the saved rejection ledger', () => {
  const h = setup({events: [event('ONE', 'New Artist and The Crew'), event('TWO', 'New Artist'), event('THREE', 'New Artist')]});
  const first = h.call('scan');
  const saved = first.events[0].proposals.find(p => p.kind === 'artist');
  h.call('decide', {changes: [{key: saved.key, revision: saved.revision, decision: 'Reject'}]});
  const queue = h.sheets.get('Archive_ID_Review');
  const row = (id, kind) => queue.rows.slice(1).find(r => r[4] === id && h.c.qdpArchiveAdminKind_(r[6]) === kind);
  row('ONE', 'collective')[0] = 'Approve';
  row('TWO', 'artist')[0] = 'Reject';
  const invalid = row('THREE', 'artist'); invalid[0] = 'Reject'; invalid[1] = 'Invalid reject: no new value'; invalid[8] = '';
  const ledger = JSON.stringify(h.sheets.get('Archive_ID_Rejects').rows);
  const events = JSON.stringify(h.sheets.get('Events_Archive').rows);
  const fresh = h.call('scan');
  assert.notEqual(fresh.scan.run, first.scan.run);
  assert.deepEqual(h.plain(fresh.summary), {pending: 3, approved: 0, applied: 0, rejected: 0, blocked: 0});
  assert.equal(fresh.events.find(e => e.eventId === 'ONE').proposals.some(p => p.kind === 'artist'), false);
  assert.equal(fresh.events.find(e => e.eventId === 'ONE').proposals.some(p => p.kind === 'collective'), true);
  assert.ok(queue.rows.slice(1).every(row => row[0] === 'Pending'));
  assert.equal(JSON.stringify(h.sheets.get('Archive_ID_Rejects').rows), ledger);
  assert.equal(JSON.stringify(h.sheets.get('Events_Archive').rows), events);
});

test('a fresh scan interrupts remaining approvals and keeps already applied source changes and publication state', () => {
  const h = setup({events: Array.from({length: 210}, (_, i) => event('E-' + i, 'New Artist'))});
  h.call('scan');
  for (const row of h.sheets.get('Archive_ID_Review').rows.slice(1)) row[0] = 'Approve';
  h.call('apply'); h.c.qdpArchiveAdminWorker();
  const fresh = h.call('scan');
  assert.equal(fresh.job.phase, 'ready');
  assert.equal(fresh.summary.pending, 10);
  assert.equal(fresh.summary.approved, 0);
  assert.equal(fresh.needsPublish, true);
  const rows = h.sheets.get('Events_Archive').rows.slice(1);
  assert.ok(rows.slice(0, 200).every(row => row[eventHeaders.indexOf('ArtistIDs (comma-separated)')] === 'NEW'));
  assert.ok(rows.slice(200).every(row => row[eventHeaders.indexOf('ArtistIDs (comma-separated)')] === ''));
  assert.deepEqual(h.publishes, []);
});

test('an old publisher finishing with an error cannot overwrite or stop a fresh scan', () => {
  const h = setup(); h.approve(h.call('scan')); h.call('apply'); h.c.qdpArchiveAdminWorker(); h.call('publish');
  let fresh;
  h.c.qdpLivePublish = () => { fresh = h.call('scan'); throw new Error('Late failure from the old publisher'); };
  h.c.qdpArchiveAdminWorker();
  const current = h.call('bootstrap');
  assert.equal(current.job.run, fresh.job.run);
  assert.equal(current.job.phase, 'ready');
  assert.equal(current.needsPublish, true);
  assert.equal(current.job.error, undefined);
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
