import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
const source = readFileSync(new URL('../../apps-script/ArchiveReview.gs', import.meta.url), 'utf8');
export const eventHeaders = ['Status', 'EventID', 'Title (internal)', 'StartDate', 'VenueID',
  'ArtistIDs (comma-separated)', 'Description', 'Location', 'HostCollectiveIDs (comma-separated)',
  'PartyID', 'ExplicitQueer (Yes/No)', 'CalendarColorId', 'QueerArtistIndicator', 'TransArtistIndicator', 'Flyer_URL',
  'Title_Public (auto w/ emojis)', 'LastEditedAt', 'QDP_EditState'];
export const event = (id, description, fields = {}) => Object.fromEntries(eventHeaders.map(h => [h, ({
  EventID: id, 'Title (internal)': 'Night ' + id, StartDate: '2025-04-01', Description: description,
  ...fields
})[h] || '']));

export function setup({ events = [event('ONE', 'Featuring New Artist and The Crew')], active = [], extra = {}, staleReads = false } = {}) {
  let nextSheetId = 1;
  const batchRequests = [], reads = [], formulaReads = [], snapshots = new Map();
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
    getFormulas() {
      formulaReads.push(this.sheet.name);
      return Array.from({length: this.height}, (_, i) => Array.from({length: this.width}, (_, j) =>
        this.sheet.formulas?.[this.row - 1 + i]?.[this.col - 1 + j] || ''));
    }
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
    CONFIG: { SHEET_EVENTS: 'Events' }, Session: {getScriptTimeZone: () => 'America/New_York'},
    ss_: () => ss, LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) || null,
      setProperty: (key, value) => props.set(key, value), deleteProperty: key => props.delete(key) }) },
    Utilities: { getUuid: randomUUID, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: {UTF_8: 'UTF_8'},
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
  return { c, ss, sheets, props, triggers, publishes, batchRequests, reads, formulaReads, get digestCount() { return digestCount; }, call, plain, proposals, approve, finish, rows };
}
