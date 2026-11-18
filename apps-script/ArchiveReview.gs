/**
 * Queer Dance Philly — Archive Updates v7.4.24
 * ArchiveReview.gs: Archive ID review, Admin Archive Updates, saved rejects,
 * approvals, resumable jobs, and artist-indicator recalculation.
 * Replace ArchiveReview.gs for inline archive editing; keep Core.gs and PublicData.gs v7.4.22.
 * Use the supplied PublicData.gs to publish every Archive YYYY tab.
 * Keep Imports.gs, scraper.gs, the manifest, services, properties, deployment
 * URL, spreadsheet data, and existing refresh triggers.
 * QDP > Archive Review: Start New Review, then Continue Review to finish.
 * Edit proposed values and Decision in Archive_ID_Review. Write Approvals
 * applies approved edits and recalculates indicators. Write Rejects saves
 * rejects separately. Starting a new scan discards unsaved review decisions;
 * the separate saved-rejection list is always retained.
 */

const QDP_ARCHIVE_ADMIN_ = Object.freeze({
  metaKey: 'QDP_ARCHIVE_ADMIN_META_V1',
  jobKey: 'QDP_ARCHIVE_ADMIN_JOB_V1',
  dirtyKey: 'QDP_ARCHIVE_ADMIN_DIRTY_V1',
  publishKey: 'QDP_ARCHIVE_ADMIN_LAST_PUBLISH_V1',
  handler: 'qdpArchiveAdminWorker',
  rowsPerRun: 1000,
  scanMillisecondsPerRun: 15000,
  pageSize: 20
});

// Reuse fresh reads only within the current request, never across executions.
let QDP_ARCHIVE_REQUEST_ = null;
function qdpArchiveRequest_(ss) {
  if (!QDP_ARCHIVE_REQUEST_ || (QDP_ARCHIVE_REQUEST_.ss !== ss && QDP_ARCHIVE_REQUEST_.spreadsheetId !== ss.getId())) {
    QDP_ARCHIVE_REQUEST_ = { ss, spreadsheetId: ss.getId(), sheets: new Map(), queue: null, lookups: null, references: null, rejects: null, sources: new Map() };
  }
  return QDP_ARCHIVE_REQUEST_;
}

function qdpArchiveLookupSheet_(ss, name) {
  const reads = qdpArchiveRequest_(ss);
  if (reads.sheets.has(name)) return reads.sheets.get(name);
  const sheet = ss.getSheetByName(name);
  if (!sheet || !sheet.getLastRow()) throw new Error('Missing lookup: ' + name);
  const values = sheet.getDataRange().getValues(), headers = values[0];
  const index = {}; headers.forEach((header, i) => { index[String(header).trim()] = i; });
  const data = { sheet, name, headers, index, rows: values.slice(1) };
  reads.sheets.set(name, data);
  return data;
}

const QDP_ARCHIVE_REVIEW_ = Object.freeze({
  sheet: 'Archive_ID_Review',
  stateKey: 'QDP_ARCHIVE_ID_REVIEW_SCAN_V1',
  scanRowsPerRun: 1200,
  applyRowsPerRun: 200,
  rejectRowsPerRun: 200,
  rejectsSheet: 'Archive_ID_Rejects',
  rejectHeaders: [
    'EventID', 'ID field', 'Rejected value', 'Archive sheet',
    'Event title', 'Rejected at', 'Scan run'
  ],
  headers: [
    'Decision', 'Result', 'Archive sheet', 'Row at scan', 'EventID',
    'Event title', 'ID field', 'Current IDs', 'Proposed IDs',
    'Matched names', 'Evidence', 'Source signature', 'Scan run',
    'Lookup signature'
  ]
});



function qdpArchiveIdReviewMenu_(ui) {
  return ui.createMenu('Archive Review')
    .addItem('Start New Review', 'qdpStartArchiveIdReview')
    .addItem('Continue Review', 'qdpContinueArchiveIdReview')
    .addSeparator()
    .addItem('Write Approvals', 'qdpApplyApprovedArchiveIds')
    .addItem('Write Rejects', 'qdpWriteRejectedArchiveIds')
    .addSeparator()
    .addItem('Open Review', 'qdpOpenArchiveIdReview')
    .addItem('Open Saved Rejects', 'qdpOpenArchiveIdRejects');
}



function qdpOpenArchiveIdReview() {
  const ss = qdpArchiveSpreadsheet_();
  const sheet = ss.getSheetByName(QDP_ARCHIVE_REVIEW_.sheet);
  if (!sheet) {
    ss.toast('Run Start New Review first.', 'QDP archive IDs', 8);
    return;
  }
  sheet.showSheet();
  ss.setActiveSheet(sheet);
}



function qdpOpenArchiveIdRejects() {
  const ss = qdpArchiveSpreadsheet_();
  const sheet = qdpArchiveRejectSheet_(ss);
  sheet.showSheet();
  ss.setActiveSheet(sheet);
}



function qdpArchiveRejectSheet_(ss) {
  const cfg = QDP_ARCHIVE_REVIEW_;
  let sheet = ss.getSheetByName(cfg.rejectsSheet);
  if (!sheet) sheet = ss.insertSheet(cfg.rejectsSheet);
  if (sheet.getLastRow()) {
    const headers = sheet.getRange(1, 1, 1, cfg.rejectHeaders.length).getValues()[0];
    if (JSON.stringify(headers) !== JSON.stringify(cfg.rejectHeaders)) {
      throw new Error(cfg.rejectsSheet + ' has unexpected headers. No reject data was changed.');
    }
  } else {
    sheet.getRange(1, 1, 1, cfg.rejectHeaders.length).setValues([cfg.rejectHeaders]);
    sheet.getRange(1, 1, 1, cfg.rejectHeaders.length)
      .setBackground('#40202f').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(1, 1).setNote(
      'Saved rejects use EventID, ID field, and Rejected value, not row numbers. ' +
      'Deleting a saved reject row allows that match to be proposed on the next scan.');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(2, 240);
    sheet.setColumnWidth(5, 260);
    sheet.getRange(2, 6, Math.max(1, sheet.getMaxRows() - 1), 1)
      .setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  return sheet;
}



function qdpArchiveRejectKey_(eventId, field, value) {
  return JSON.stringify([eventId, field, value].map(v => String(v || '').trim()));
}



function qdpArchiveSavedRejects_(ss) {
  const reads = qdpArchiveRequest_(ss);
  if (reads.rejects) return reads.rejects;
  const cfg = QDP_ARCHIVE_REVIEW_;
  const sheet = qdpArchiveRejectSheet_(ss);
  const keys = new Set();
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, cfg.rejectHeaders.length).getValues() : [];
  rows.forEach(row => {
        if (row.slice(0, 3).some(v => !String(v || '').trim())) return;
        keys.add(qdpArchiveRejectKey_(row[0], row[1], row[2]));
  });
  return (reads.rejects = { sheet, keys, rows });
}



function qdpArchiveRejectedValues_(reviewRow) {
  const field = String(reviewRow[6] || '').trim();
  const valid = ['VenueID', 'ArtistIDs (comma-separated)',
    'HostCollectiveIDs (comma-separated)', 'PartyID', 'ExplicitQueer (Yes/No)'];
  if (!String(reviewRow[4] || '').trim() || !valid.includes(field)) return [];
  const current = new Set(qdpArchiveIds_(reviewRow[7]));
  return [...new Set(qdpArchiveIds_(reviewRow[8]))]
    .filter(value => !current.has(value) &&
      (field !== 'ExplicitQueer (Yes/No)' || value === 'Yes'));
}



function qdpArchiveUnsavedRejects_(review, saved) {
  return review.map((r, i) => ({ r, queueRow: i + 2,
    values: qdpArchiveRejectedValues_(r) }))
    .filter(item => item.r[0] === 'Reject' &&
      (!item.values.length || item.values.some(value =>
        !saved.has(qdpArchiveRejectKey_(item.r[4], item.r[6], value)))));
}



function qdpWriteRejectedArchiveIds() {
  QDP_ARCHIVE_REQUEST_ = null;
  return qdpArchiveWithLock_(() => qdpArchiveWriteRejects_());
}

function qdpArchiveWriteRejects_(batchLimit) {
    const cfg = QDP_ARCHIVE_REVIEW_;
    const ss = qdpArchiveSpreadsheet_();
    const queue = ss.getSheetByName(cfg.sheet);
    if (!queue || queue.getLastRow() < 2) {
      ss.toast('No review decisions to save.', 'QDP archive IDs', 8);
      return { saved: 0, processed: 0, remaining: 0, invalid: 0 };
    }
    qdpArchiveReviewSheet_(ss, false);
    const review = qdpArchiveAdminQueue_(ss).rows;
    const saved = qdpArchiveSavedRejects_(ss);
    // A stale scan can still save rejects: this action writes no archive cells.
    const rejected = qdpArchiveUnsavedRejects_(review, saved.keys);
    const batch = rejected.filter(item => item.values.length)
      .slice(0, Math.max(cfg.rejectRowsPerRun, Number(batchLimit) || 0));
    const now = new Date();
    const output = [];
    const invalid = rejected.filter(item => !item.values.length).length;
    batch.forEach(item => {
      item.values.forEach(value => {
        const key = qdpArchiveRejectKey_(item.r[4], item.r[6], value);
        if (saved.keys.has(key)) return;
        saved.keys.add(key);
        output.push([String(item.r[4]).trim(), String(item.r[6]).trim(), value,
          item.r[2], item.r[5], now, item.r[12]]);
      });
    });
    if (output.length) {
      const first = saved.sheet.getLastRow() + 1;
      const needed = first + output.length - 1 - saved.sheet.getMaxRows();
      if (needed > 0) saved.sheet.insertRowsAfter(saved.sheet.getMaxRows(), needed);
      saved.sheet.getRange(first, 1, output.length, cfg.rejectHeaders.length).setValues(output);
      saved.rows.push(...output);
      // Persist the ledger before marking review rows saved.
      SpreadsheetApp.flush();
    }
    // Include previously saved rows so retries repair status after a partial run.
    const cells = [];
    review.forEach((r, i) => {
      if (r[0] !== 'Reject') return;
      const values = qdpArchiveRejectedValues_(r);
      if (values.length && values.every(value => saved.keys.has(
        qdpArchiveRejectKey_(r[4], r[6], value))) && r[1] !== 'Rejected (saved)') {
        cells.push({ sheet: queue, row: i + 2, column: 2, value: 'Rejected (saved)' });
      }
    });
    rejected.filter(item => !item.values.length).forEach(item => {
      if (item.r[1] !== 'Invalid reject: no new value') {
        cells.push({ sheet: queue, row: item.queueRow, column: 2, value: 'Invalid reject: no new value' });
      }
    });
    qdpArchiveWriteCells_(ss, cells);
    const remaining = qdpArchiveUnsavedRejects_(review, saved.keys)
      .filter(item => item.values.length).length;
    ss.toast('Saved ' + output.length + ' rejected matches. ' + remaining +
      ' reject decisions remain; ' + invalid + ' invalid rows need correction.',
      'QDP archive IDs', 10);
    return { saved: output.length, processed: batch.length, remaining, invalid };
}



function qdpArchiveSheets_(ss, includeActive = false) {
  const names = ss.getSheets().map(sheet => sheet.getName())
    .filter(name => name === 'Events_Archive' || /^Archive \d{4}$/.test(name));
  if (!names.includes('Events_Archive')) throw new Error('Events_Archive is missing.');
  const sorted = names.sort((a, b) => a === 'Events_Archive' ? -1
    : b === 'Events_Archive' ? 1 : Number(b.slice(8)) - Number(a.slice(8)));
  if (includeActive && ss.getSheetByName(CONFIG.SHEET_EVENTS)) sorted.push(CONFIG.SHEET_EVENTS);
  return sorted;
}



function qdpArchiveWithLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return callback(); } finally { lock.releaseLock(); }
}



function qdpArchiveSpreadsheet_() {
  // The main QDP script already defines ss_(). This fallback supports a
  // spreadsheet-bound project if that helper is ever renamed.
  if (typeof ss_ === 'function') return ss_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open the QDP spreadsheet-bound Apps Script project.');
  return ss;
}



function qdpArchiveLayout_(sheet, suppliedHeaders) {
  if (!sheet) throw new Error('An archive sheet is missing.');
  const name = sheet.getName();
  if (!sheet.getLastRow()) throw new Error(name + ' is empty.');
  const headers = (suppliedHeaders || sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0])
    .map(value => String(value || '').trim());
  const wanted = {
    status: 'Status', eventId: 'EventID', title: 'Title (internal)',
    start: 'StartDate', venue: 'VenueID',
    artists: 'ArtistIDs (comma-separated)', description: 'Description',
    location: 'Location', collectives: 'HostCollectiveIDs (comma-separated)',
    party: 'PartyID', explicit: 'ExplicitQueer (Yes/No)',
    colorId: 'CalendarColorId', queerIndicator: 'QueerArtistIndicator',
    transIndicator: 'TransArtistIndicator'
  };
  const aliases = {
    eventId: ['EventID', 'Event ID'], title: ['Title (internal)', 'Title_Public', 'Title'],
    start: ['StartDate', 'Start Date'], artists: ['ArtistIDs (comma-separated)', 'ArtistIDs', 'Artist IDs'],
    collectives: ['HostCollectiveIDs (comma-separated)', 'HostCollectiveIDs', 'Host Collective IDs'],
    venue: ['VenueID', 'Venue ID', 'Venue Id'], party: ['PartyID', 'Party ID', 'Party Id'],
    explicit: ['ExplicitQueer (Yes/No)', 'Explicit Queer (Yes/No)', 'ExplicitQueer']
  };
  const optional = new Set(['status', 'colorId', 'queerIndicator', 'transIndicator', 'location']);
  const columns = {};
  Object.keys(wanted).forEach(key => {
    const candidates = aliases[key] || [wanted[key]];
    const accepted = key === 'title' ? candidates.filter(h => headers.includes(h)).slice(0, 1) : candidates;
    const matches = headers.map((h, i) => accepted.includes(h) ? i + 1 : 0).filter(Boolean);
    if (matches.length > 1 || (!matches.length && !optional.has(key))) {
      throw new Error(name + ': expected exactly one ' + wanted[key] + ' header.');
    }
    columns[key] = matches[0] || 0;
  });
  return { sheet, name, columns, headers, firstDataRow: 2, width: headers.length };
}



function qdpArchiveNormalize_(value) {
  return String(value == null ? '' : value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}



function qdpArchiveAliasIndex_(rows, idHeader, nameHeaders, aliasHeader, handleHeader) {
  const headers = rows[0].map(x => String(x || '').trim());
  function col(h) { return headers.indexOf(h); }
  const idCol = col(idHeader);
  if (idCol < 0 || !nameHeaders.some(h => col(h) >= 0)) {
    throw new Error('Lookup sheet is missing ' + idHeader + ' or its name column.');
  }
  const index = new Map();
  const ids = new Set();
  function add(raw, id, handle) {
    const label = String(raw || '').trim().replace(/^\[(.*)\]$/, '$1');
    const key = handle ? label.toLowerCase() : qdpArchiveNormalize_(label);
    // Short plain words are very likely to be incidental prose.
    if (!key || (!handle && key.replace(/ /g, '').length < 4)) return;
    const indexKey = (handle ? '@' : '#') + key;
    if (!index.has(indexKey)) index.set(indexKey, new Map());
    index.get(indexKey).set(id, label);
  }
  rows.slice(1).forEach(row => {
    const id = String(row[idCol] || '').trim();
    // A lookup cell containing several IDs is malformed, not a usable ID.
    if (!id || id.includes(',')) return;
    ids.add(id);
    nameHeaders.forEach(h => { if (col(h) >= 0) add(row[col(h)], id, false); });
    if (col(aliasHeader) >= 0) {
      String(row[col(aliasHeader)] || '').split(',').forEach(a => add(a, id, false));
    }
    if (col(handleHeader) >= 0) {
      const handle = String(row[col(handleHeader)] || '').trim().replace(/^@/, '');
      if (/^[A-Za-z0-9_.]{4,}$/.test(handle)) add('@' + handle, id, true);
    }
  });
  const aliases = [];
  index.forEach((owners, indexedKey) => {
    // A shared name/alias is ambiguous; it cannot safely assign either ID.
    if (owners.size !== 1) return;
    const [id, label] = owners.entries().next().value;
    const handle = indexedKey[0] === '@';
    const key = indexedKey.slice(1);
    const matcher = handle ? new RegExp('(?:^|[^a-z0-9_])' +
      key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '(?=$|[^a-z0-9_.])', 'i') : null;
    aliases.push({ id, label, handle, key, matcher });
  });
  aliases.sort((a, b) => b.key.length - a.key.length);
  return { ids, aliases };
}



// Compare a complete street number + street name + suffix. Never guess from
// a ZIP code, a partial street, or an address shared by several venues.
function qdpArchiveStreetKeys_(text) {
  const tokens = qdpArchiveNormalize_(text).split(' ').filter(Boolean);
  const directions = {
    n: 'north', north: 'north', s: 'south', south: 'south',
    e: 'east', east: 'east', w: 'west', west: 'west'
  };
  const suffixes = {
    st: 'street', street: 'street', ave: 'avenue', avenue: 'avenue',
    rd: 'road', road: 'road', blvd: 'boulevard', boulevard: 'boulevard',
    pkwy: 'parkway', parkway: 'parkway', dr: 'drive', drive: 'drive',
    ln: 'lane', lane: 'lane', pl: 'place', place: 'place',
    ct: 'court', court: 'court', cir: 'circle', circle: 'circle',
    sq: 'square', square: 'square', hwy: 'highway', highway: 'highway',
    way: 'way'
  };
  const found = new Map();
  tokens.forEach((number, i) => {
    if (!/^\d{1,5}$/.test(number)) return;
    let first = i + 1;
    const direction = directions[tokens[first]] || '';
    if (direction) first++;
    for (let end = first + 1; end < Math.min(first + 6, tokens.length); end++) {
      const suffix = suffixes[tokens[end]];
      if (!suffix) continue;
      const street = tokens.slice(first, end);
      if (!street.length || street.some(t => /^\d{5}$/.test(t))) break;
      const key = [number, direction, street.join(' '), suffix]
        .filter(Boolean).join(' ');
      found.set(key, { key, number });
      break;
    }
  });
  return Array.from(found.values());
}



function qdpArchiveAddressIndex_(rows, ids) {
  const headers = rows[0].map(x => String(x || '').trim());
  const idCol = headers.indexOf('VenueID');
  const addressCol = headers.indexOf('Address');
  if (addressCol < 0) throw new Error('Venues is missing its Address column.');
  const index = new Map();
  rows.slice(1).forEach(row => {
    const id = String(row[idCol] || '').trim();
    if (!ids.has(id) || id === 'SECLOC-001' || id === 'TOBEAN-001') return;
    const address = String(row[addressCol] || '').trim();
    qdpArchiveStreetKeys_(address).forEach(({ key }) => {
      if (!index.has(key)) index.set(key, new Map());
      index.get(key).set(id, address);
    });
  });
  return index;
}



function qdpArchiveLookups_(ss) {
  const reads = qdpArchiveRequest_(ss);
  if (reads.lookups) return reads.lookups;
  const specs = {
    venue: ['Venues', 'VenueID', ['VenueName', 'Public_Name'], 'Aliases', 'Instagram'],
    artists: ['Artists', 'ArtistID', ['StageName'], 'Aliases', 'Instagram'],
    collectives: ['Collectives', 'CollectiveID', ['CollectiveName', 'Public_Name'], 'Aliases', 'CollInsta'],
    party: ['Parties', 'PartyID', ['PartyName'], 'PartyAliases', 'PartyInsta']
  };
  const out = {};
  const fingerprint = [];
  Object.keys(specs).forEach(type => {
    const [sheetName, idHeader, names, aliases, handle] = specs[type];
    const data = qdpArchiveLookupSheet_(ss, sheetName);
    const rows = [data.headers, ...data.rows];
    out[type] = qdpArchiveAliasIndex_(rows, idHeader, names, aliases, handle);
    if (type === 'artists') {
      const headers = rows[0].map(x => String(x || '').trim());
      const idCol = headers.indexOf('ArtistID');
      const queerCol = headers.indexOf('Identity_Queer');
      const transCol = headers.indexOf('Identity_Trans');
      const consentCol = headers.indexOf('PublicIdentity_Consent');
      if (queerCol < 0 || transCol < 0 || consentCol < 0) {
        throw new Error('Artists is missing an identity indicator column.');
      }
      out[type].byId = {};
      rows.slice(1).forEach(row => {
        const id = String(row[idCol] || '').trim();
        if (!out[type].ids.has(id)) return;
        out[type].byId[id] = {
          queer: String(row[queerCol] || '').trim().toLowerCase() === 'yes',
          trans: String(row[transCol] || '').trim().toLowerCase() === 'yes',
          consent: String(row[consentCol] || '').trim().toLowerCase() === 'yes'
        };
      });
    }
    if (type === 'venue') {
      // These are placeholders in the QDP venue table, not actual places.
      out[type].aliases = out[type].aliases.filter(a =>
        a.id !== 'SECLOC-001' && a.id !== 'TOBEAN-001');
      out[type].addresses = qdpArchiveAddressIndex_(rows, out[type].ids);
    }
    if (type === 'venue' || type === 'party') {
      const headers = rows[0].map(x => String(x || '').trim());
      const flagCol = headers.indexOf(type === 'venue' ? 'Queer_Venue' : 'PartyQueer');
      if (flagCol < 0) throw new Error(sheetName + ' is missing its queer flag.');
      const idCol = headers.indexOf(idHeader);
      out[type].queer = new Set(rows.slice(1).filter(row =>
        String(row[flagCol] || '').trim().toLowerCase() === 'yes')
        .map(row => String(row[idCol] || '').trim()));
    }
    // Address and queer-flag edits must invalidate an in-progress review too.
    fingerprint.push([type, rows]);
  });
  if (typeof qdpAliasMatches_ !== 'function') {
    throw new Error('Install Core.gs v7.4.17 or later before scanning archive IDs.');
  }
  const core = typeof qdpPublicSheet_ === 'function' ? buildLookupMaps_(reads) : buildLookupMaps_();
  const lists = { venue: core.venueAliases, artists: core.artistAliases,
    collectives: core.collAliases, party: core.partyAliases };
  Object.keys(lists).forEach(type => {
    out[type].sharedAliases = lists[type].filter(alias => out[type].ids.has(alias.id) &&
      !(type === 'venue' && ['SECLOC-001', 'TOBEAN-001'].includes(alias.id)));
    out[type].core = core;
    out[type].type = type;
  });
  out.core = core;
  out.signature = qdpArchiveDigest_(JSON.stringify(['shared-core-matching-v1', fingerprint]));
  reads.lookups = out;
  return out;
}



function qdpArchiveMatches_(text, lookup) {
  if (lookup.sharedAliases) {
    const normalized = normalizeKey_(fixMojibake_(text));
    const found = new Map();
    const directories = { venue: 'venueById', artists: 'artistById',
      collectives: 'collById', party: 'partyById' };
    lookup.sharedAliases.forEach(alias => {
      const entity = lookup.core[directories[lookup.type]][alias.id];
      const matchText = lookup.type === 'artists' && entity && entity.keywordExclusion
        ? normalized.replace(entity.keywordExclusion, ' ') : normalized;
      if (qdpAliasMatches_(alias, matchText)) {
        found.set(alias.id, { id: alias.id,
          label: entity && (entity.stage || entity.name || entity.publicName) || alias.id });
      }
    });
    return Array.from(found.values());
  }
  const normalized = ' ' + qdpArchiveNormalize_(text) + ' ';
  const raw = String(text || '').toLowerCase();
  const found = new Map();
  lookup.aliases.forEach(a => {
    if (found.has(a.id)) return;
    const hit = a.handle
      ? a.matcher.test(raw)
      : normalized.indexOf(' ' + a.key + ' ') >= 0;
    if (hit) found.set(a.id, a.label);
  });
  return Array.from(found, ([id, label]) => ({ id, label }));
}



function qdpArchiveAddressMatches_(text, lookup) {
  const found = new Map();
  qdpArchiveStreetKeys_(text).forEach(({ key, number }) => {
    const owners = lookup.addresses.get(key);
    if (!owners) return;
    owners.forEach((label, id) => {
      if (!found.has(id)) found.set(id, { id, label, kind: 'address', number });
    });
  });
  return Array.from(found.values());
}



function qdpArchiveDigest_(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text))
  ).replace(/=+$/, '');
}



function qdpArchiveSignature_(row, c) {
  return qdpArchiveDigest_([
    c.status, c.eventId, c.start, c.title, c.description,
    c.location, c.colorId
  ].map(column => {
    const v = row[column - 1];
    return v instanceof Date ? v.toISOString() : String(v == null ? '' : v);
  }).join('\u001e'));
}



function qdpArchiveIndicatorValues_(rawArtistIds, lookups, partyId) {
  const ids = qdpArchiveIds_(rawArtistIds);

  const unknown = ids.filter(id => !lookups.artists.ids.has(id));
  if (unknown.length) return { unknown };
  // Use the same reporting rule and optional consent gate as the Events sheet.
  const result = computeArtistIndicators_(ids, lookups.core || { artistById: lookups.artists.byId }, partyId);
  return {
    queer: result.hasQueer ? 'Yes' : (ids.length ? 'No' : ''),
    trans: result.hasTrans ? 'Yes' : (ids.length ? 'No' : '')
  };
}



function qdpArchiveRefreshIndicators_(target, lookups, cells) {
  const c = target.layout.columns;
  const sheet = target.layout.sheet;
  const row = target.row || sheet.getRange(target.number, 1, 1, target.layout.width).getValues()[0];
  const ids = row[c.artists - 1];
  const partyId = row[c.party - 1];
  const expected = qdpArchiveIndicatorValues_(ids, lookups, partyId);
  if (expected.unknown) return { changed: 0, unknown: expected.unknown };
  function write(column, value, highlight = false) {
    if (cells) cells.push({ sheet, row: target.number, column, value, highlight });
    else {
      const cell = sheet.getRange(target.number, column);
      cell.setValue(value);
      if (highlight) cell.setBackground('#fff2b3');
    }
  }
  let changed = 0;
  [
    [c.queerIndicator, expected.queer],
    [c.transIndicator, expected.trans]
  ].forEach(([column, value]) => {
    if (!column) return;
    if (String(row[column - 1] || '').trim() === value) return;
    write(column, value, true);
    changed++;
  });
  // Active events still participate in Calendar sync; mark their changes just
  // as the ordinary Admin event editor does. Historical records stay historical.
  if (target.layout.name === CONFIG.SHEET_EVENTS) {
    const headers = target.layout.headers;
    const edited = headers.findIndex(h => ['LastEditedAt', 'Last Edited At'].includes(h));
    if (edited >= 0) write(edited + 1, new Date().toISOString());
    const titleColumn = headers.findIndex(h => ['Title_Public (auto w/ emojis)', 'Title Public (auto w/ emojis)'].includes(h));
    if (titleColumn >= 0 && typeof buildEventPublicTitle_ === 'function') {
      write(titleColumn + 1, buildEventPublicTitle_(
        row[c.title - 1], qdpArchiveIds_(ids), lookups.core, partyId));
    }
  }
  return { changed, unknown: [] };
}

// Write only the changed cells. The Sheets service sends the whole set in one
// atomic request, preserving formulas and all unrelated event fields.
function qdpArchiveWriteCells_(ss, cells, extraRequests = []) {
  if (!cells.length && !extraRequests.length) return;
  if (typeof Sheets !== 'undefined') {
    const requests = cells.map(cell => {
      const value = { userEnteredValue: { stringValue: String(cell.value) } };
      if (cell.highlight) value.userEnteredFormat = {
        backgroundColor: { red: 1, green: 242 / 255, blue: 179 / 255 }
      };
      return { updateCells: {
        start: { sheetId: cell.sheet.getSheetId(), rowIndex: cell.row - 1, columnIndex: cell.column - 1 },
        rows: [{ values: [value] }],
        fields: 'userEnteredValue' + (cell.highlight ? ',userEnteredFormat.backgroundColor' : '')
      } };
    });
    Sheets.Spreadsheets.batchUpdate({ requests: requests.concat(extraRequests), includeSpreadsheetInResponse: false }, ss.getId());
  } else {
    // Preserve the older spreadsheet-menu workflow when the advanced service
    // has not been enabled. The Admin batch-save action requires that service.
    cells.forEach(cell => {
      const range = cell.sheet.getRange(cell.row, cell.column);
      range.setValue(cell.value);
      if (cell.highlight) range.setBackground('#fff2b3');
    });
  }
  const cached = qdpArchiveRequest_(ss).queue;
  if (cached && cached.sheet) for (const cell of cells) {
    if (cell.sheet.getSheetId() === cached.sheet.getSheetId() && cell.row >= 2 && cached.rows[cell.row - 2]) {
      cached.rows[cell.row - 2][cell.column - 1] = cell.value;
    }
  }
  for (const cell of cells) {
    const source = qdpArchiveRequest_(ss).sources.get(cell.sheet.getName());
    if (source?.rows[cell.row - 1]) source.rows[cell.row - 1][cell.column - 1] = cell.value;
  }
}



function qdpArchiveEvidence_(text, matches) {
  const source = String(text || '').replace(/\s+/g, ' ');
  const lower = source.toLowerCase();
  return matches.slice(0, 3).map(match => {
    const term = match.label.toLowerCase();
    let hit = lower.indexOf(term);
    if (hit < 0 && match.kind === 'address') {
      const numberMatch = source.match(new RegExp('\\b' + match.number + '\\b'));
      if (numberMatch) hit = numberMatch.index;
    }
    if (hit < 0) return source.slice(0, 150);
    const start = Math.max(0, hit - 65);
    const end = Math.min(source.length, hit + term.length + 100);
    return (start ? '…' : '') + source.slice(start, end) +
      (end < source.length ? '…' : '');
  }).join(' | ').slice(0, 500);
}



function qdpArchiveExplicitBasis_(row, c, lookups, venueMatches, partyMatches) {
  const desc = String(row[c.description - 1] || '').split(/---\s*QDP IDs\s*---/i)[0];
  const text = [row[c.title - 1], desc].filter(Boolean).join('\n');
  const keyword = text.match(/\b(?:queer|gay|lgbtq?|trans|sapphic|lesbian|non[-\s\u2010-\u2015]?binary)\b/i);
  if (keyword) return { matched: 'Event copy: ' + keyword[0],
    evidence: qdpArchiveEvidence_(text, [{ label: keyword[0] }]) };
  const currentPartyId = String(row[c.party - 1] || '').trim();
  const partyId = currentPartyId ||
    (partyMatches.length === 1 ? partyMatches[0].id : '');
  if (lookups.party.queer.has(partyId)) return {
    matched: 'PartyQueer=Yes: ' + partyId,
    evidence: 'Party ' + partyId + ' is marked queer in Parties.',
    requires: currentPartyId ? '' : 'PartyID'
  };
  const currentVenueId = String(row[c.venue - 1] || '').trim();
  const venueId = currentVenueId ||
    (venueMatches.length === 1 ? venueMatches[0].id : '');
  if (lookups.venue.queer.has(venueId)) return {
    matched: 'Queer_Venue=Yes: ' + venueId,
    evidence: 'Venue ' + venueId + ' is marked queer in Venues.',
    requires: currentVenueId ? '' : 'VenueID'
  };
  if (Number(row[c.colorId - 1]) === 3) return {
    matched: 'CalendarColorId=3',
    evidence: 'Calendar color is Grape (3).'
  };
  return null;
}



function qdpArchiveProposals_(row, layout, lookups, rejectedKeys = new Set()) {
  const c = layout.columns;
  const eventId = String(row[c.eventId - 1] || '').trim();
  function permitted(field, matches) {
    return matches.filter(match => !rejectedKeys.has(
      qdpArchiveRejectKey_(eventId, field, match.id)));
  }
  const desc = String(row[c.description - 1] || '').split(/---\s*QDP IDs\s*---/i)[0];
  const title = String(row[c.title - 1] || '');
  const location = String(row[c.location - 1] || '');
  const full = [title, desc].filter(Boolean).join('\n');
  const locationUndisclosed = /\b(tba|to be announced|not disclosed|secret location)\b/i
    .test(location);
  const venueAtLocation = locationUndisclosed ? []
    : qdpArchiveMatches_(location, lookups.venue);
  const venueAddressAtLocation = locationUndisclosed ? []
    : qdpArchiveAddressMatches_(location, lookups.venue);
  const venueInCopy = locationUndisclosed ? [] : qdpArchiveMatches_(full, lookups.venue);
  const venueAddressInCopy = locationUndisclosed ? []
    : qdpArchiveAddressMatches_(full, lookups.venue);
  const venueMatches = permitted('VenueID', venueAtLocation.length ? venueAtLocation
    : venueAddressAtLocation.length ? venueAddressAtLocation
    : venueInCopy.length ? venueInCopy : venueAddressInCopy);
  const venueEvidence = venueAtLocation.length || venueAddressAtLocation.length
    ? location : full;
  const partyInTitle = qdpArchiveMatches_(title, lookups.party);
  const partyMatches = permitted('PartyID', partyInTitle.length ? partyInTitle
    : qdpArchiveMatches_(desc, lookups.party));
  const fields = [
    { key: 'venue', label: 'VenueID', single: true,
      matches: venueMatches, evidence: venueEvidence },
    { key: 'artists', label: 'ArtistIDs (comma-separated)', single: false,
      matches: permitted('ArtistIDs (comma-separated)',
        qdpArchiveMatches_(full, lookups.artists)), evidence: full },
    { key: 'collectives', label: 'HostCollectiveIDs (comma-separated)', single: false,
      matches: permitted('HostCollectiveIDs (comma-separated)',
        qdpArchiveMatches_(full, lookups.collectives)), evidence: full },
    { key: 'party', label: 'PartyID', single: true,
      matches: partyMatches,
      evidence: partyInTitle.length ? title : desc }
  ];
  const proposals = fields.map(f => {
    const current = String(row[c[f.key] - 1] || '').trim();
    if (!f.matches.length || (f.single && current)) return null;
    const old = qdpArchiveIds_(current);
    const added = f.matches.filter(m => !old.includes(m.id));
    if (!added.length) return null;
    const proposed = f.single
      ? added.map(m => m.id).join(', ')
      : Array.from(new Set(old.concat(added.map(m => m.id)))).join(', ');
    const unknownOldId = !f.single && old.some(id => !lookups[f.key].ids.has(id));
    return {
      field: f.label, current, proposed,
      result: unknownOldId ? 'Resolve old ID first'
        : f.single && added.length > 1 ? 'Choose one ID'
        : f.key === 'venue' && added[0].kind === 'address'
          ? 'Verify address' : 'Ready',
      matched: added.map(m => (m.kind === 'address' ? 'Address ' : '') +
        m.label + ' → ' + m.id).join('; '),
      evidence: qdpArchiveEvidence_(f.evidence, added)
    };
  }).filter(Boolean);
  const explicitBasis = qdpArchiveExplicitBasis_(
    row, c, lookups, venueMatches, partyMatches);
  const currentExplicit = String(row[c.explicit - 1] || '').trim();
  if (explicitBasis && currentExplicit.toLowerCase() !== 'yes' &&
      !rejectedKeys.has(qdpArchiveRejectKey_(eventId, 'ExplicitQueer (Yes/No)', 'Yes'))) {
    proposals.push({
      field: 'ExplicitQueer (Yes/No)', current: currentExplicit,
      proposed: 'Yes', result: 'Ready',
      matched: explicitBasis.matched,
      evidence: explicitBasis.evidence + (explicitBasis.requires
        ? ' Approve the ' + explicitBasis.requires + ' proposal as well.' : '')
    });
  }
  return proposals;
}



function qdpArchiveReviewSheet_(ss, reset) {
  const cfg = QDP_ARCHIVE_REVIEW_;
  let sheet = ss.getSheetByName(cfg.sheet);
  if (!sheet) sheet = ss.insertSheet(cfg.sheet);
  if (sheet.getLastRow() && !reset) {
    const actual = sheet.getRange(1, 1, 1, cfg.headers.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(cfg.headers)) {
      throw new Error(cfg.sheet + ' has unexpected headers. No review data was changed.');
    }
  }
  if (reset) {
    if (sheet.getLastRow()) {
      const actual = sheet.getRange(1, 1, 1, cfg.headers.length).getValues()[0];
      if (JSON.stringify(actual) !== JSON.stringify(cfg.headers)) {
        throw new Error(cfg.sheet + ' already contains other data. No review data was changed.');
      }
    }
    if (sheet.getFilter()) sheet.getFilter().remove();
    sheet.clear();
    qdpArchiveRequest_(ss).queue = { sheet, rows: [] };
    sheet.getRange(1, 1, 1, cfg.headers.length).setValues([cfg.headers]);
    sheet.getRange(1, 1, 1, cfg.headers.length)
      .setBackground('#40202f').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(1, 1).setNote(
      'Approve or Reject records your decision here. Write Approvals updates archive cells. ' +
      'Write Rejects saves rejected suggestions separately in Archive_ID_Rejects.');
    sheet.getRange(1, 2).setNote(
      'Applied means the approved value was written to the archive. Rejected (saved) means ' +
      'that match will be skipped in future reviews. Resolve old ID first cannot be applied. ' +
      'Unconfirmed queer evidence means its venue/party basis was not approved.');
    sheet.getRange(1, 9).setNote(
      'For Choose one ID, replace the comma-separated candidates with exactly one ID before approving.');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 95);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(6, 260);
    sheet.setColumnWidth(9, 220);
    sheet.setColumnWidth(10, 260);
    sheet.setColumnWidth(11, 400);
    sheet.hideColumns(12, 3);
  }
  return sheet;
}



function qdpArchiveValidation_(sheet) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pending', 'Approve', 'Reject'], true)
    .setAllowInvalid(false).build();
  sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), 1).setDataValidation(rule);
}



function qdpStartArchiveIdReview(options) {
  QDP_ARCHIVE_REQUEST_ = null;
  return qdpArchiveWithLock_(() => qdpArchiveStartReview_(options));
}

function qdpArchiveStartReview_(options) {
    const ss = qdpArchiveSpreadsheet_();
    const archiveNames = qdpArchiveSheets_(ss, options && options.includeActive);
    const layouts = archiveNames.map(name =>
      qdpArchiveLayout_(ss.getSheetByName(name)));
    const lookups = qdpArchiveLookups_(ss);
    // Validate the permanent rejection ledger without changing its contents.
    // A fresh scan replaces the review, including unsaved/invalid decisions.
    qdpArchiveSavedRejects_(ss);
    qdpArchiveReviewSheet_(ss, true);
    const state = {
      run: Utilities.getUuid(), startedAt: new Date().toISOString(),
      options: options || {}, index: 0,
      nextRow: layouts[0].firstDataRow,
      archiveNames, lastRows: layouts.map(l => l.sheet.getLastRow()),
      lookupSignature: lookups.signature,
      scanned: 0, proposed: 0
    };
    PropertiesService.getScriptProperties().setProperty(
      QDP_ARCHIVE_REVIEW_.stateKey, JSON.stringify(state));
    return qdpArchiveScanChunk_(ss, layouts, lookups, state);
}



function qdpContinueArchiveIdReview() {
  QDP_ARCHIVE_REQUEST_ = null;
  return qdpArchiveWithLock_(() => qdpArchiveContinueReview_());
}

function qdpArchiveContinueReview_() {
    const ss = qdpArchiveSpreadsheet_();
    const raw = PropertiesService.getScriptProperties()
      .getProperty(QDP_ARCHIVE_REVIEW_.stateKey);
    if (!raw) throw new Error('No scan in progress. Run qdpStartArchiveIdReview first.');
    const state = JSON.parse(raw);
    const archiveNames = qdpArchiveSheets_(ss, state.options && state.options.includeActive);
    if (JSON.stringify(archiveNames) !== JSON.stringify(state.archiveNames)) {
      throw new Error('Archive tabs changed during the scan. Restart the review scan.');
    }
    const layouts = archiveNames.map(name =>
      qdpArchiveLayout_(ss.getSheetByName(name)));
    if (layouts.some((l, i) => l.sheet.getLastRow() !== state.lastRows[i])) {
      throw new Error('An archive changed during the scan. Restart the review scan.');
    }
    const lookups = qdpArchiveLookups_(ss);
    if (lookups.signature !== state.lookupSignature) {
      throw new Error('A lookup sheet changed during the scan. Restart the review scan.');
    }
    return qdpArchiveScanChunk_(ss, layouts, lookups, state);
}



function qdpArchiveScanChunk_(ss, layouts, lookups, state) {
  const cfg = QDP_ARCHIVE_REVIEW_;
  const review = qdpArchiveRequest_(ss).queue;
  // Continuing a scan only appends proposals; do not download the growing
  // review table again just to append the next batch.
  const queue = review ? review.sheet : qdpArchiveReviewSheet_(ss, false);
  const rejectedKeys = qdpArchiveSavedRejects_(ss).keys;
  const output = [];
  let budget = state.options && state.options.admin ? QDP_ARCHIVE_ADMIN_.rowsPerRun : cfg.scanRowsPerRun;
  const deadline = Date.now() + QDP_ARCHIVE_ADMIN_.scanMillisecondsPerRun;
  while (state.index < layouts.length && budget > 0 && Date.now() < deadline) {
    const l = layouts[state.index];
    const remaining = l.sheet.getLastRow() - state.nextRow + 1;
    if (remaining < 1) {
      state.index++;
      if (state.index < layouts.length) state.nextRow = layouts[state.index].firstDataRow;
      continue;
    }
    const count = Math.min(budget, remaining);
    const values = l.sheet.getRange(state.nextRow, 1, count, l.width).getValues();
    let processed = 0;
    values.some((row, i) => {
      if (processed && Date.now() >= deadline) return true;
      processed++;
      const id = String(row[l.columns.eventId - 1] || '').trim();
      if (!id) return;
      // A cancelled/deleted listing is not evidence that an artist played.
      const status = String(row[l.columns.status - 1] || '');
      const title = String(row[l.columns.title - 1] || '');
      if (/deleted|cancelled|canceled/i.test(status) ||
        /^\(DELETED ENTRY\)/i.test(title)) return;
      if (!qdpArchiveAdminInScope_(row, l, state.options || {})) return;
      const proposals = qdpArchiveProposals_(row, l, lookups, rejectedKeys)
        .filter(p => qdpArchiveAdminProposalInScope_(p, state.options || {}));
      if (!proposals.length) return;
      const signature = qdpArchiveSignature_(row, l.columns);
      proposals.forEach(p => output.push([
        'Pending', p.result, l.name, state.nextRow + i, id,
        String(row[l.columns.title - 1] || ''), p.field, p.current,
        p.proposed, p.matched, p.evidence, signature, state.run,
        lookups.signature
      ]));
    });
    state.nextRow += processed;
    state.scanned += processed;
    budget -= processed;
  }
  if (output.length) {
    const first = queue.getLastRow() + 1;
    const needed = first + output.length - 1 - queue.getMaxRows();
    if (needed > 0) queue.insertRowsAfter(queue.getMaxRows(), needed);
    queue.getRange(first, 1, output.length, cfg.headers.length).setValues(output);
    if (review) review.rows.push(...output.map(row => row.slice()));
    // Set validation once at completion instead of rewriting the entire
    // growing review after every batch.
    state.proposed += output.length;
  }
  const finished = state.index === layouts.length;
  if (finished && queue.getLastRow() > 1) qdpArchiveValidation_(queue);
  if (finished && queue.getLastRow() > 1 && !queue.getFilter()) {
    queue.getRange(1, 1, queue.getLastRow(), cfg.headers.length).createFilter();
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty(QDP_ARCHIVE_ADMIN_.metaKey, JSON.stringify({
    run: state.run, startedAt: state.startedAt || '', options: state.options || {},
    scanned: state.scanned, total: state.lastRows.reduce((sum, n) => sum + Math.max(0, n - 1), 0),
    proposed: state.proposed, finishedAt: finished ? new Date().toISOString() : ''
  }));
  if (finished) props.deleteProperty(cfg.stateKey);
  else props.setProperty(cfg.stateKey, JSON.stringify(state));
  const message = 'Scanned ' + state.scanned + ' rows; ' + state.proposed +
    ' proposed field changes. ' + (finished ? 'Review is ready.' : 'Run Continue again.');
  ss.toast(message, 'QDP archive IDs', 10);
  return { finished, scanned: state.scanned, proposed: state.proposed };
}



function qdpApplyApprovedArchiveIds() {
  QDP_ARCHIVE_REQUEST_ = null;
  return qdpArchiveWithLock_(() => qdpArchiveApplyApprovals_());
}

function qdpArchiveApplyApprovals_() {
    const cfg = QDP_ARCHIVE_REVIEW_;
    const ss = qdpArchiveSpreadsheet_();
    if (PropertiesService.getScriptProperties().getProperty(cfg.stateKey)) {
      throw new Error('Finish the scan before applying approvals.');
    }
    const queue = qdpArchiveReviewSheet_(ss, false);
    if (queue.getLastRow() < 2) return { applied: 0, remaining: 0 };
    const review = qdpArchiveAdminQueue_(ss).rows;
    const approved = review.map((r, i) => ({ r, queueRow: i + 2 }))
      .filter(x => x.r[0] === 'Approve' &&
        (x.r[1] === 'Ready' || x.r[1] === 'Choose one ID' ||
          x.r[1] === 'Verify address' || x.r[1] === 'Invalid proposed IDs'))
      // Apply venue/party choices before any ExplicitQueer proposal that
      // depends on them, even if the review sheet was sorted by the user.
      .sort((a, b) => Number(a.r[6] === 'ExplicitQueer (Yes/No)') -
        Number(b.r[6] === 'ExplicitQueer (Yes/No)'));
    const batch = approved.slice(0, cfg.applyRowsPerRun);
    if (!batch.length) {
      ss.toast('No eligible approvals remain. Check Result for blocked rows.',
        'QDP archive IDs', 8);
      return { applied: 0, remaining: 0 };
    }
    const layouts = {};
    const byId = {};
    const meta = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.metaKey) || {};
    const allowed = new Set(qdpArchiveSheets_(ss, meta.options && meta.options.includeActive));
    [...new Set(batch.map(item => String(item.r[2])))].filter(name => allowed.has(name)).forEach(name => {
      const l = qdpArchiveLayout_(ss.getSheetByName(name));
      layouts[name] = l;
      const count = l.sheet.getLastRow() - l.firstDataRow + 1;
      const values = count > 0
        ? l.sheet.getRange(l.firstDataRow, 1, count, l.width).getValues() : [];
      byId[name] = new Map();
      values.forEach((row, i) => {
        const id = String(row[l.columns.eventId - 1] || '').trim();
        if (!id) return;
        if (!byId[name].has(id)) byId[name].set(id, []);
        byId[name].get(id).push({ row, original: row.slice(), number: l.firstDataRow + i });
      });
    });
    const lookups = qdpArchiveLookups_(ss);
    if (typeof computeArtistIndicators_ !== 'function') {
      throw new Error('The main QDP computeArtistIndicators_ helper is missing. No approvals applied.');
    }
    const fields = {
      'VenueID': ['venue', true],
      'ArtistIDs (comma-separated)': ['artists', false],
      'HostCollectiveIDs (comma-separated)': ['collectives', false],
      'PartyID': ['party', true],
      'ExplicitQueer (Yes/No)': ['explicit', true]
    };
    let applied = 0;
    const touched = new Map();
    const cells = [];
    batch.forEach(item => {
      const r = item.r;
      const l = layouts[String(r[2])];
      const field = fields[String(r[6])];
      let result = '';
      if (!l || !field || String(r[12]) === '') result = 'Invalid review row';
      else if (String(r[13]) !== lookups.signature) result = 'Stale: lookup changed';
      else {
        const [key, single] = field;
        const proposed = qdpArchiveIds_(r[8]);
        const old = qdpArchiveIds_(r[7]);
        const candidates = (byId[l.name].get(String(r[4]).trim()) || [])
          .filter(x => qdpArchiveSignature_(x.row, l.columns) === String(r[11]));
        if (candidates.length !== 1) result = 'Stale: event missing or duplicated';
        else if (!proposed.length || (single && proposed.length !== 1) ||
          (key === 'explicit' ? proposed[0] !== 'Yes' :
            proposed.some(id => !old.includes(id) && !lookups[key].ids.has(id))) ||
          new Set(proposed).size !== proposed.length ||
          (!single && (old.some(id => !proposed.includes(id)) ||
            old.some(id => !lookups[key].ids.has(id))))) {
          result = 'Invalid proposed IDs';
        } else {
          const target = candidates[0];
          const col = l.columns[key];
          const current = String(target.row[col - 1] || '').trim();
          if (current !== String(r[7] || '').trim()) {
            result = 'Stale: IDs changed';
          } else if (single && key !== 'explicit' && current) {
            result = 'Stale: ID already set';
          } else if (key === 'explicit' && !qdpArchiveExplicitBasis_(
            target.row, l.columns, lookups, [], [])) {
            result = 'Unconfirmed queer evidence';
          } else {
            const next = proposed.join(', ');
            if (next === current) result = 'No change';
            else {
              // Recheck all affected rows together immediately before commit.
                cells.push({ sheet: l.sheet, row: target.number, column: col, value: next, highlight: true });
                target.row[col - 1] = next;
                applied++;
                result = 'Applied';
                const targetKey = l.name + '\u001e' + target.number;
                if (!touched.has(targetKey)) {
                  touched.set(targetKey, { layout: l, number: target.number, row: target.row, original: target.original,
                    reviewRows: [] });
                }
                touched.get(targetKey).reviewRows.push(item.queueRow);
            }
          }
        }
      }
      cells.push({ sheet: queue, row: item.queueRow, column: 2, value: result });
    });
    let indicatorCells = 0;
    let unresolvedEvents = 0;
    const spans = new Map();
    touched.forEach(target => {
      const name = target.layout.name;
      const span = spans.get(name) || {layout: target.layout, first: target.number, last: target.number};
      span.first = Math.min(span.first, target.number); span.last = Math.max(span.last, target.number); spans.set(name, span);
    });
    spans.forEach(span => { span.rows = span.layout.sheet.getRange(span.first, 1, span.last - span.first + 1, span.layout.width).getValues(); });
    touched.forEach(target => {
      const span = spans.get(target.layout.name), current = span.rows[target.number - span.first];
      if (JSON.stringify(current) !== JSON.stringify(target.original)) {
        throw new Error('An event changed while saving. Retry to recheck the records. No changes from this batch were written.');
      }
      const result = qdpArchiveRefreshIndicators_(target, lookups, cells);
      indicatorCells += result.changed;
      if (result.unknown.length) {
        unresolvedEvents++;
        target.reviewRows.forEach(row => cells.push({ sheet: queue, row, column: 2,
          value: 'Applied; indicators need ID cleanup' }));
      }
    });
    if (applied) qdpArchiveAdminMarkDirty_();
    qdpArchiveWriteCells_(ss, cells);
    const remaining = approved.length - batch.length;
    ss.toast('Applied ' + applied + ' changes. ' + remaining +
      ' approved rows remain. Refreshed ' + indicatorCells +
      ' indicator cells; ' + unresolvedEvents + ' events need ID cleanup.',
      'QDP archive IDs', 10);
    return { applied, processed: batch.length, remaining,
      indicatorCells, unresolvedEvents };
}

/* ---------------- Admin / Archive Updates ---------------- */

function qdpArchiveAdminRead_(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  return raw ? JSON.parse(raw) : null;
}

function qdpArchiveAdminWrite_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

function qdpArchiveAdminMarkDirty_() {
  qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.dirtyKey, {
    revision: Utilities.getUuid(), updatedAt: new Date().toISOString()
  });
}

function qdpArchiveAdminDate_(value) {
  if (value instanceof Date && !isNaN(+value)) {
    return Utilities.formatDate(value, 'America/New_York', 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return isNaN(+parsed) ? '' : Utilities.formatDate(parsed, 'America/New_York', 'yyyy-MM-dd');
}

function qdpArchiveAdminProfiles_(kind) {
  // Artists use their own Admin API; the Index profile loader only supports
  // venues, parties, and collectives.
  return kind === 'artist' ? qdpAdminListArtists_() : qdpAdminListIndexProfiles_(kind);
}

function qdpArchiveAdminOptions_(body) {
  const options = { admin: true, includeActive: body.includeActive !== false,
    from: String(body.from || '').trim(), to: String(body.to || '').trim(),
    kind: String(body.kind || '').trim(), profileId: String(body.profileId || '').trim() };
  if (options.kind && !['artist', 'venue', 'party', 'collective'].includes(options.kind)) {
    throw new Error('Choose an artist, venue, party, collective, or all profiles.');
  }
  if (options.profileId && !options.kind) throw new Error('Choose a profile type first.');
  for (const key of ['from', 'to']) {
    const value = options[key];
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      throw new Error('Enter a valid date range.');
    }
  }
  if (options.from && options.to && options.from > options.to) throw new Error('The end date must follow the start date.');
  if (options.profileId && !qdpArchiveAdminReferences_()[options.kind].some(p => p.id === options.profileId)) {
    throw new Error('That profile is no longer in the Index. Refresh the page.');
  }
  return options;
}

function qdpArchiveAdminInScope_(row, layout, options) {
  if (!options.from && !options.to) return true;
  const date = qdpArchiveAdminDate_(row[layout.columns.start - 1]);
  return !!date && (!options.from || date >= options.from) && (!options.to || date <= options.to);
}

function qdpArchiveAdminKind_(field) {
  return ({ VenueID: 'venue', PartyID: 'party',
    'ArtistIDs (comma-separated)': 'artist',
    'HostCollectiveIDs (comma-separated)': 'collective' })[field] || 'classification';
}

function qdpArchiveAdminProposalInScope_(proposal, options) {
  if (!options.kind) return true;
  if (qdpArchiveAdminKind_(proposal.field) !== options.kind) return false;
  if (!options.profileId) return true;
  const old = qdpArchiveIds_(proposal.current);
  if (old.includes(options.profileId) || !qdpArchiveIds_(proposal.proposed).includes(options.profileId)) return false;
  // A focused scan only proposes the selected profile; other matches can be
  // reviewed in a later full scan. Ambiguity still requires a deliberate choice.
  proposal.proposed = [...old, options.profileId].join(', ');
  return true;
}

function qdpArchiveAdminQueue_(ss) {
  const reads = qdpArchiveRequest_(ss);
  if (reads.queue) return reads.queue;
  const sheet = ss.getSheetByName(QDP_ARCHIVE_REVIEW_.sheet);
  if (!sheet || sheet.getLastRow() < 2) return (reads.queue = { sheet, rows: [] });
  qdpArchiveReviewSheet_(ss, false);
  return (reads.queue = { sheet, rows: sheet.getRange(2, 1, sheet.getLastRow() - 1,
    QDP_ARCHIVE_REVIEW_.headers.length).getValues() });
}

function qdpArchiveAdminKey_(row) {
  return qdpArchiveDigest_(JSON.stringify([row[12], row[2], row[4], row[6], row[11]]));
}

function qdpArchiveAdminRevision_(row) {
  return qdpArchiveDigest_(JSON.stringify(row));
}

function qdpArchiveAdminRowState_(row) {
  if (/^Applied|^No change$/.test(row[1])) return 'applied';
  if (row[1] === 'Rejected (saved)') return 'rejected';
  if (!['Ready', 'Choose one ID', 'Verify address', 'Invalid proposed IDs'].includes(row[1])) return 'blocked';
  return row[0] === 'Approve' ? 'approved' : 'pending';
}

function qdpArchiveAdminActive_(job) {
  return job && ['scanning', 'applying', 'publishing-live', 'publishing-archive'].includes(job.phase);
}

function qdpArchiveAdminStopTriggers_() {
  ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === QDP_ARCHIVE_ADMIN_.handler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function qdpArchiveAdminEnsureTrigger_() {
  if (!ScriptApp.getProjectTriggers().some(trigger =>
      trigger.getHandlerFunction() === QDP_ARCHIVE_ADMIN_.handler)) {
    ScriptApp.newTrigger(QDP_ARCHIVE_ADMIN_.handler).timeBased().everyMinutes(1).create();
  }
}

function qdpArchiveAdminReady_() {
  if (qdpArchiveAdminActive_(qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.jobKey))) {
    throw new Error('Wait for the current archive operation to finish.');
  }
  if (PropertiesService.getScriptProperties().getProperty(QDP_ARCHIVE_REVIEW_.stateKey)) {
    throw new Error('Finish or replace the current scan before reviewing changes.');
  }
}

function qdpArchiveAdminReferences_() {
  const ss = qdpArchiveSpreadsheet_(), reads = qdpArchiveRequest_(ss);
  if (reads.references) return reads.references;
  const out = {};
  const specs = { artist: ['Artists', 'ArtistID', ['StageName']],
    venue: ['Venues', 'VenueID', ['Public_Name', 'VenueName']], party: ['Parties', 'PartyID', ['PartyName']],
    collective: ['Collectives', 'CollectiveID', ['Public_Name', 'CollectiveName']] };
  Object.keys(specs).forEach(kind => {
    const [name, id, names] = specs[kind], data = qdpArchiveLookupSheet_(ss, name);
    out[kind] = data.rows.map(row => ({id: String(row[data.index[id]] || '').trim(),
      name: names.map(name => String(row[data.index[name]] || '').trim()).find(Boolean) || String(row[data.index[id]] || '').trim()}))
      .filter(profile => /^[A-Za-z0-9_-]{1,80}$/.test(profile.id));
    if (kind === 'venue' && typeof QDP_ADMIN_VENUE_LABELS_ !== 'undefined') {
      QDP_ADMIN_VENUE_LABELS_.forEach((label, id) => {
        if (!out[kind].some(profile => profile.id === id)) out[kind].push({id, name: label.Public_Name});
      });
    }
    out[kind].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  });
  reads.references = out;
  return out;
}

function qdpArchiveAdminPage_(body) {
  const ss = qdpArchiveSpreadsheet_();
  const job = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.jobKey);
  const scan = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.metaKey);
  const scanInProgress = !!PropertiesService.getScriptProperties().getProperty(QDP_ARCHIVE_REVIEW_.stateKey);
  const progress = {job, scan, scanInProgress,
    lastPublishedAt: PropertiesService.getScriptProperties().getProperty(QDP_ARCHIVE_ADMIN_.publishKey) || '',
    needsPublish: !!qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.dirtyKey)};
  if (body.progressOnly && qdpArchiveAdminActive_(job)) return {...progress, progressOnly: true};
  const queue = qdpArchiveAdminQueue_(ss);
  const summary = { pending: 0, approved: 0, applied: 0, rejected: 0, blocked: 0 };
  const groups = new Map();
  const query = String(body.query || '').trim().toLowerCase().slice(0, 200);
  const view = ['pending', 'approved', 'applied', 'rejected', 'blocked'].includes(body.view) ? body.view : '';
  queue.rows.forEach(row => {
    const state = qdpArchiveAdminRowState_(row);
    summary[state]++;
    if (view && state !== view) return;
    if (query && ![row[4], row[5], row[7], row[8], row[9], row[10]].join(' ').toLowerCase().includes(query)) return;
    const key = JSON.stringify([row[2], row[4]]);
    if (!groups.has(key)) groups.set(key, { eventId: String(row[4]), title: String(row[5]),
      sheet: String(row[2]), proposals: [] });
    groups.get(key).proposals.push(row);
  });
  const all = Array.from(groups.values());
  const requestedOffset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const offset = Math.min(requestedOffset, Math.max(0, Math.floor((all.length - 1) / QDP_ARCHIVE_ADMIN_.pageSize) * QDP_ARCHIVE_ADMIN_.pageSize));
  const events = all.slice(offset, offset + QDP_ARCHIVE_ADMIN_.pageSize);
  events.forEach(event => {
    // Hash only the proposals on this page; totals and filtering need no
    // per-row cryptographic work across the rest of the review.
    event.proposals = event.proposals.map(row => ({key: qdpArchiveAdminKey_(row), revision: qdpArchiveAdminRevision_(row),
      field: String(row[6]), kind: qdpArchiveAdminKind_(row[6]), currentIds: qdpArchiveIds_(row[7]),
      proposedIds: qdpArchiveIds_(row[8]), decision: String(row[0]), result: String(row[1]),
      matched: String(row[9]), evidence: String(row[10]), state: qdpArchiveAdminRowState_(row)}));
    const source = qdpArchiveAdminSource_(ss, event.sheet);
    const {headers, byId} = source;
    const column = names => headers.findIndex(h => names.includes(String(h).trim()));
    const matches = byId.get(event.eventId) || [];
    if (matches.length !== 1) { event.sourceIssue = 'Event missing or duplicated; scan again after correcting the source.'; return; }
    const target = qdpArchiveAdminCachedTarget_(ss, event.sheet, event.eventId);
    event.record = qdpArchiveAdminEventRecord_(target);
    event.title = event.record.title;
    const row = target.row;
    event.description = String(row[column(['Description'])] == null ? '' : row[column(['Description'])]);
    event.date = qdpArchiveAdminDate_(row[column(['StartDate', 'Start Date'])]);
    const flyer = row[column(['FlyerURL', 'Flyer URL', 'Flyer_URL'])] ||
      row[column(['RawFlyerURL', 'Raw Flyer URL'])] ||
      (typeof extractFlyerUrl_ === 'function' ? extractFlyerUrl_(row[column(['Description'])]) : '');
    event.flyerUrl = typeof qdpArchiveLink_ === 'function' ? qdpArchiveLink_(flyer) : '';
  });
  const unsavedRejectCount = queue.rows.filter(row => row[0] === 'Reject' && row[1] !== 'Rejected (saved)' && qdpArchiveRejectedValues_(row).length).length;
  const payload = { summary, ...progress, unsavedRejectCount, separatePublish: typeof qdpPublicPublishSaved_ === 'function',
    inlineEventEdits: true, events, totalEvents: all.length, offset, pageSize: QDP_ARCHIVE_ADMIN_.pageSize };
  if (body.references) payload.references = qdpArchiveAdminReferences_();
  if (body.includeRejects) Object.assign(payload, qdpArchiveAdminRejects_(body));
  return payload;
}

/* The individual event editor resolves the source by sheet and EventID on
 * every read/save. Historical records stay in their original archive tab. */
function qdpArchiveAdminEventKey_(sheet, id) { return JSON.stringify([String(sheet), String(id)]); }

function qdpArchiveAdminEventRevision_(target) {
  // Formula expressions are protected; volatile calculated values need not
  // make an otherwise unchanged event appear to be an external edit.
  const values = target.row.map((value, i) => target.formulas[i] ? null : value);
  return qdpArchiveDigest_(JSON.stringify([target.layout.name, target.eventId, target.layout.headers, values, target.formulas]));
}

function qdpArchiveAdminSource_(ss, name) {
  const reads = qdpArchiveRequest_(ss);
  if (reads.sources.has(name)) return reads.sources.get(name);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('This event source is no longer available. Refresh Archive Updates.');
  const range = sheet.getDataRange(), rows = range.getValues();
  const layout = qdpArchiveLayout_(sheet, rows[0]), byId = new Map();
  rows.slice(1).forEach((row, i) => {
    const id = String(row[layout.columns.eventId - 1] || '').trim();
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({row, number: i + 2});
  });
  const source = {sheet, layout, rows, headers: layout.headers, byId, formulas: null, range};
  reads.sources.set(name, source);
  return source;
}

function qdpArchiveAdminCachedTarget_(ss, name, id) {
  const source = qdpArchiveAdminSource_(ss, name), matches = source.byId.get(id) || [];
  if (matches.length !== 1) throw new Error(matches.length ? 'This event is duplicated in its source tab. Correct the duplicate before editing.' : 'This event is no longer in its source tab. Refresh Archive Updates.');
  if (!source.formulas) source.formulas = source.range.getFormulas();
  const target = {ss, sheet: source.sheet, layout: source.layout, row: matches[0].row.slice(), number: matches[0].number,
    eventId: id, formulas: source.formulas[matches[0].number - 1].slice()};
  target.revision = qdpArchiveAdminEventRevision_(target);
  return target;
}

function qdpArchiveAdminEventTarget_(body) {
  const ss = qdpArchiveSpreadsheet_();
  const name = String(body.sheet || '').trim(), id = String(body.eventId || '').trim();
  if (!qdpArchiveSheets_(ss, true).includes(name) || !id || id.length > 200) {
    throw new Error('Choose a recorded event from Archive Updates.');
  }
  const sheet = ss.getSheetByName(name), layout = qdpArchiveLayout_(sheet);
  const rows = sheet.getDataRange().getValues();
  const matches = rows.slice(1).map((row, i) => ({ row, number: i + 2 }))
    .filter(item => String(item.row[layout.columns.eventId - 1] || '').trim() === id);
  if (matches.length !== 1) throw new Error(matches.length ? 'This event is duplicated in its source tab. Correct the duplicate before editing.' :
    'This event is no longer in its source tab. Refresh Archive Updates.');
  const target = { ss, sheet, layout, ...matches[0], eventId: id };
  target.formulas = sheet.getRange(target.number, 1, 1, layout.width).getFormulas()[0];
  target.revision = qdpArchiveAdminEventRevision_(target);
  return target;
}

function qdpArchiveAdminEventFields_(target) {
  const specs = [
    [['Title (internal)', 'Title'], 'Title', 'Event', 'text', 500],
    [['Title_Public (auto w/ emojis)', 'Title Public (auto w/ emojis)', 'Title_Public'], 'Public title', 'Event', 'text', 500],
    [['Description'], 'Description', 'Event', 'long', 50000],
    [['Status'], 'Status', 'Event', 'text', 100],
    [['StartDate', 'Start Date'], 'Start date', 'Date and time', 'date', 10],
    [['StartTime', 'Start Time'], 'Start time', 'Date and time', 'time', 20],
    [['EndDate', 'End Date'], 'End date', 'Date and time', 'date', 10],
    [['EndTime', 'End Time'], 'End time', 'Date and time', 'time', 20],
    [['Timezone', 'Time zone'], 'Time zone', 'Date and time', 'text', 100],
    [['VenueID', 'Venue ID', 'Venue Id'], 'Venue', 'Location', 'venue', 80],
    [['Location'], 'Location', 'Location', 'text', 3000],
    [['Address (from Venue)', 'Address from Venue', 'Address'], 'Address', 'Location', 'text', 1000],
    [['Neighborhood (from Venue)', 'Neighborhood from Venue', 'Neighborhood'], 'Neighborhood', 'Location', 'neighborhood', 300],
    [['ArtistIDs (comma-separated)', 'ArtistIDs', 'Artist IDs'], 'Artists', 'Associations', 'artist', 10000],
    [['HostCollectiveIDs (comma-separated)', 'HostCollectiveIDs', 'Host Collective IDs'], 'Collectives', 'Associations', 'collective', 10000],
    [['PartyID', 'Party ID', 'Party Id'], 'Party', 'Associations', 'party', 80],
    [['ExplicitQueer (Yes/No)', 'Explicit Queer (Yes/No)', 'ExplicitQueer'], 'Explicitly queer event', 'Visibility', 'flag', 3],
    [['Publish_To_Web', 'Publish To Web'], 'Show on website', 'Visibility', 'flag', 3],
    [['Event_URL', 'Event URL', 'EventURL', 'Event Link', 'EventLink'], 'Event link', 'Links and photos', 'url', 3000],
    [['Ticket_URL', 'Ticket URL', 'TicketURL'], 'Ticket link', 'Links and photos', 'url', 3000],
    [['Source_URL', 'Source URL'], 'Source link', 'Links and photos', 'url', 3000],
    [['Instagram_URL', 'Instagram URL'], 'Instagram link', 'Links and photos', 'url', 3000],
    [['Flyer_URL', 'Flyer URL', 'FlyerURL'], 'Flyer image URL', 'Links and photos', 'url', 3000],
    [['RawFlyerURL', 'Raw Flyer URL'], 'Original flyer link', 'Links and photos', 'url', 3000],
    [['PhotoURLs', 'Photo URLs'], 'Photo URLs', 'Links and photos', 'long', 50000]
  ];
  const headers = target.layout.headers;
  const tzColumn = headers.findIndex(h => ['Timezone', 'Time zone'].includes(h));
  const zone = String(target.row[tzColumn] || 'America/New_York');
  return specs.map(([aliases, label, group, type, maxLength]) => {
    const key = aliases.find(alias => headers.includes(alias));
    if (!key) return null;
    const column = headers.indexOf(key) + 1, raw = target.row[column - 1];
    let value = raw instanceof Date && !isNaN(+raw) ? Utilities.formatDate(raw, zone,
      type === 'date' ? 'yyyy-MM-dd' : type === 'time' ? 'HH:mm:ss' : 'yyyy-MM-dd HH:mm:ss') : String(raw == null ? '' : raw);
    if (type === 'time' && typeof raw === 'number' && raw >= 0 && raw < 1) {
      const seconds = Math.round(raw * 86400) % 86400;
      value = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(n => String(n).padStart(2, '0')).join(':');
    }
    return { key, label, group, type, maxLength, column, value, readOnly: !!target.formulas[column - 1],
      manualLocation: ['Location', 'Address', 'Neighborhood'].includes(label) };
  }).filter(Boolean);
}

function qdpArchiveAdminEventRecord_(target) {
  return { eventId: target.eventId, sheet: target.layout.name, revision: target.revision,
    title: String(target.row[target.layout.columns.title - 1] || target.eventId),
    fields: qdpArchiveAdminEventFields_(target).map(({column, ...field}) => field) };
}

function qdpArchiveAdminReadEvent_(body) {
  const target = qdpArchiveAdminEventTarget_(body);
  return { event: qdpArchiveAdminEventRecord_(target), references: qdpArchiveAdminReferences_() };
}

function qdpArchiveAdminCheckEventSave_() {
  const sync = typeof qdpAdminReadSyncJob_ === 'function' ? qdpAdminReadSyncJob_() : null;
  if (sync && ['queued', 'running'].includes(sync.state)) throw new Error('A Calendar sync is running. Keep your edits here and save when it finishes.');
}

function qdpArchiveAdminPrepareEvent_(body, target) {
  if (body.expectedRevision !== target.revision) throw new Error('This event changed since you opened it. Your edits were not saved. Reload the event and review the changes.');
  if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) throw new Error('Choose event fields to save.');
  const fields = qdpArchiveAdminEventFields_(target), byKey = new Map(fields.map(field => [field.key, field]));
  const lookups = qdpArchiveLookups_(target.ss), changed = new Set(), updates = new Map();
  const row = target.row.slice(), c = target.layout.columns;
  function set(column, value) {
    if (column && !target.formulas[column - 1] && String(row[column - 1] == null ? '' : row[column - 1]) !== String(value)) {
      row[column - 1] = value; updates.set(column, value);
    }
  }
  for (const [key, raw] of Object.entries(body.fields)) {
    const field = byKey.get(key);
    if (!field || field.readOnly) throw new Error('That event field cannot be edited: ' + key);
    if (typeof raw !== 'string' || raw.length > field.maxLength) throw new Error(field.label + ' contains invalid or excessive text.');
    let value = field.type === 'long' ? raw.replace(/\r\n?/g, '\n') : raw.trim();
    if (value === field.value) continue;
    if (field.label === 'Title' && !value) throw new Error('Enter an event title.');
    if (field.label === 'Start date' && !value) throw new Error('Enter a start date.');
    if (field.type === 'flag' && !['', 'Yes', 'No'].includes(value)) throw new Error('Choose Yes, No, or Unspecified for ' + field.label + '.');
    if (field.type === 'url' && value && !qdpArchiveLink_(value)) throw new Error('Enter an HTTP or HTTPS URL for ' + field.label + '.');
    if (field.type === 'date' && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('Enter a valid ' + field.label.toLowerCase() + '.');
    if (field.type === 'time' && value && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) throw new Error('Use a 24-hour time for ' + field.label + '.');
    if (field.type === 'neighborhood' && value && typeof QDP_NEIGHBORHOODS_ !== 'undefined' && !QDP_NEIGHBORHOODS_.includes(value)) throw new Error('Choose a neighborhood from the list.');
    const lookupKey = {artist: 'artists', collective: 'collectives', venue: 'venue', party: 'party'}[field.type];
    if (lookupKey) {
      const ids = qdpArchiveIds_(value), original = qdpArchiveIds_(field.value);
      if (['venue', 'party'].includes(field.type) && ids.length > 1) throw new Error('Choose one ' + field.label.toLowerCase() + '.');
      const unknown = ids.filter(id => !lookups[lookupKey].ids.has(id) && !original.includes(id) &&
        !(field.type === 'venue' && ['SECLOC-001', 'TOBEAN-001'].includes(id)));
      if (unknown.length) throw new Error('Unknown ' + field.label.toLowerCase() + ': ' + unknown.join(', '));
      value = ids.join(', ');
    }
    changed.add(key); set(field.column, value);
  }
  const venueId = String(row[c.venue - 1] || '').trim();
  if (venueId && fields.some(field => field.manualLocation && changed.has(field.key))) throw new Error('Clear the venue before entering a manual location.');
  const venueChanged = updates.has(c.venue), artistsChanged = updates.has(c.artists), partyChanged = updates.has(c.party);
  const column = aliases => target.layout.headers.findIndex(h => aliases.includes(h)) + 1;
  if (venueChanged && venueId) {
    const venue = lookups.core.venueById[venueId];
    if (venue) {
      set(c.location, venue.publicName || venue.internal || venue.name || venueId);
      set(column(['Address (from Venue)', 'Address from Venue', 'Address']), venue.address || '');
      set(column(['Neighborhood (from Venue)', 'Neighborhood from Venue', 'Neighborhood']), venue.neighborhood || '');
    }
    if (!updates.has(c.explicit) && lookups.venue.queer.has(venueId)) set(c.explicit, 'Yes');
  }
  if (artistsChanged || partyChanged) {
    const indicators = qdpArchiveIndicatorValues_(row[c.artists - 1], lookups, row[c.party - 1]);
    if (!indicators.unknown) { set(c.queerIndicator, indicators.queer); set(c.transIndicator, indicators.trans); }
  }
  if ((updates.has(c.title) || artistsChanged || partyChanged) && typeof buildEventPublicTitle_ === 'function') {
    const publicTitle = column(['Title_Public (auto w/ emojis)', 'Title Public (auto w/ emojis)', 'Title_Public']);
    if (!updates.has(publicTitle)) set(publicTitle, buildEventPublicTitle_(row[c.title - 1], qdpArchiveIds_(row[c.artists - 1]), lookups.core, row[c.party - 1]));
  }
  if (updates.has(c.description) && !updates.has(c.explicit) && typeof contentImpliesExplicitQueer_ === 'function' &&
      contentImpliesExplicitQueer_(row[c.title - 1], row[c.description - 1])) set(c.explicit, 'Yes');
  const start = fields.find(field => field.label === 'Start date'), end = fields.find(field => field.label === 'End date');
  if (start && end && (changed.has(start.key) || changed.has(end.key))) {
    const from = updates.has(start.column) ? row[start.column - 1] : start.value;
    const to = updates.has(end.column) ? row[end.column - 1] : end.value;
    if (from && to && to < from) throw new Error('The end date cannot precede the start date.');
  }
  if (updates.size && target.layout.name === CONFIG.SHEET_EVENTS) set(column(['LastEditedAt', 'Last Edited At']), new Date().toISOString());
  return {target, row, updates};
}

function qdpArchiveAdminSaveEvent_(body) {
  qdpArchiveAdminReady_();
  if (typeof Sheets === 'undefined') throw new Error('Enable Google Sheets API under Apps Script Services before saving.');
  qdpArchiveAdminCheckEventSave_();
  const target = qdpArchiveAdminEventTarget_(body), plan = qdpArchiveAdminPrepareEvent_(body, target);
  if (plan.updates.size) {
    const latest = qdpArchiveAdminEventTarget_(body);
    if (latest.revision !== target.revision) throw new Error('This event changed while saving. Nothing was written; your edits have been kept.');
    qdpArchiveAdminMarkDirty_();
    qdpArchiveWriteCells_(target.ss, [...plan.updates].map(([column, value]) => ({sheet: target.sheet, row: latest.number, column, value})));
  }
  const saved = {...target, row: plan.row}; saved.revision = qdpArchiveAdminEventRevision_(saved);
  return {event: qdpArchiveAdminEventRecord_(saved), needsPublish: !!plan.updates.size};
}

function qdpArchiveAdminPrepareInline_(ss, edits, decisions, queue) {
  const cells = [], plans = [], savedEventKeys = [], seen = new Set();
  if (!edits.length) return {cells, plans, savedEventKeys, editedEvents: 0, inlineApplied: 0};
  qdpArchiveAdminCheckEventSave_();
  const allowed = new Set(qdpArchiveSheets_(ss, true)), lookups = qdpArchiveLookups_(ss);
  const overrides = new Map(decisions.map(item => [item.number, item]));
  let inlineApplied = 0;
  for (const edit of edits) {
    const name = String(edit.sheet || '').trim(), id = String(edit.eventId || '').trim();
    const key = qdpArchiveAdminEventKey_(name, id);
    if (!allowed.has(name) || !id || id.length > 200 || seen.has(key)) throw new Error('Choose each recorded event only once when saving. Nothing was saved.');
    seen.add(key);
    const target = qdpArchiveAdminCachedTarget_(ss, name, id);
    const manual = qdpArchiveAdminPrepareEvent_(edit, target), merged = {...edit.fields}, approved = [];
    queue.rows.forEach((row, i) => {
      if (String(row[2]) !== name || String(row[4]) !== id) return;
      const override = overrides.get(i + 2), decision = override?.decision || row[0];
      if (decision !== 'Approve' || !['pending', 'approved'].includes(qdpArchiveAdminRowState_(row))) return;
      const field = ({VenueID: ['venue', true], PartyID: ['party', true], 'ExplicitQueer (Yes/No)': ['explicit', true],
        'ArtistIDs (comma-separated)': ['artists', false], 'HostCollectiveIDs (comma-separated)': ['collectives', false]})[row[6]];
      if (!field || String(row[13]) !== lookups.signature || qdpArchiveSignature_(target.row, target.layout.columns) !== String(row[11])) {
        throw new Error(id + ': an approved suggestion changed. Start a fresh scan or clear that approval before saving event edits. Nothing was saved.');
      }
      const [kind, single] = field, column = target.layout.columns[kind], fieldKey = target.layout.headers[column - 1];
      const proposed = qdpArchiveIds_(override ? override.proposed : row[8]), old = qdpArchiveIds_(row[7]);
      if (String(target.row[column - 1] || '').trim() !== String(row[7] || '').trim() || !proposed.length ||
        (single && proposed.length !== 1) || (!single && old.some(value => !proposed.includes(value))) ||
        (kind === 'explicit' ? proposed[0] !== 'Yes' : proposed.some(value => !lookups[kind].ids.has(value)))) {
        throw new Error(id + ': an approved association is stale or invalid. Clear that approval before saving event edits. Nothing was saved.');
      }
      if (single) {
        if (manual.updates.has(column) && String(manual.row[column - 1] || '').trim() !== proposed[0]) {
          throw new Error(id + ': the edited ' + row[6] + ' conflicts with a checked revision. Choose one value before saving. Nothing was saved.');
        }
        merged[fieldKey] = proposed[0];
      } else {
        merged[fieldKey] = [...new Set([...qdpArchiveIds_(manual.row[column - 1]), ...proposed.filter(value => !old.includes(value))])].join(', ');
      }
      approved.push({row, number: i + 2, kind});
    });
    const plan = qdpArchiveAdminPrepareEvent_({...edit, fields: merged}, target);
    if (approved.some(item => item.kind === 'explicit') && !qdpArchiveExplicitBasis_(plan.row, target.layout.columns, lookups, [], [])) {
      throw new Error(id + ': the edited event no longer supports the checked queer classification. Clear that revision or edit the classification directly. Nothing was saved.');
    }
    plans.push(plan); savedEventKeys.push(key);
    for (const [column, value] of plan.updates) cells.push({sheet: target.sheet, row: target.number, column, value});
    const applied = new Set(approved.map(item => item.number));
    inlineApplied += approved.length;
    for (const item of approved) cells.push({sheet: queue.sheet, row: item.number, column: 2, value: 'Applied'});
    if (plan.updates.size) queue.rows.forEach((row, i) => {
      const override = overrides.get(i + 2);
      if (String(row[2]) === name && String(row[4]) === id && plan.updates.has(target.layout.columns.title)) {
        cells.push({sheet: queue.sheet, row: i + 2, column: 6, value: plan.row[target.layout.columns.title - 1]});
      }
      if (String(row[2]) === name && String(row[4]) === id && !applied.has(i + 2) &&
          (override?.decision || row[0]) !== 'Reject' && !['applied', 'rejected'].includes(qdpArchiveAdminRowState_(row))) {
        cells.push({sheet: queue.sheet, row: i + 2, column: 2, value: 'Event edited; scan again'});
      }
    });
  }
  // Recheck all affected rows together before the single decision/event commit.
  const spans = new Map();
  for (const {target, updates} of plans) if (updates.size) {
    const span = spans.get(target.layout.name) || {sheet: target.sheet, width: target.layout.width, first: target.number, last: target.number};
    span.first = Math.min(span.first, target.number); span.last = Math.max(span.last, target.number); spans.set(target.layout.name, span);
  }
  for (const span of spans.values()) {
    const range = span.sheet.getRange(span.first, 1, span.last - span.first + 1, span.width);
    span.rows = range.getValues(); span.formulas = range.getFormulas();
  }
  for (const {target, updates} of plans) if (updates.size) {
    const span = spans.get(target.layout.name), index = target.number - span.first;
    if (qdpArchiveAdminEventRevision_({...target, row: span.rows[index], formulas: span.formulas[index]}) !== target.revision) {
      throw new Error(target.eventId + ': this event changed while saving. Nothing was written; keep your edits and refresh.');
    }
  }
  return {cells, plans, savedEventKeys, editedEvents: plans.filter(plan => plan.updates.size).length, inlineApplied};
}

function qdpArchiveAdminDecide_(body, eventEdits = []) {
  qdpArchiveAdminReady_();
  if (!Array.isArray(body.changes) || (!body.changes.length && !eventEdits.length) || body.changes.length > 5000) {
    throw new Error('Save between one and 5,000 suggestions at a time.');
  }
  const ss = qdpArchiveSpreadsheet_(), queue = qdpArchiveAdminQueue_(ss);
  const indexed = new Map();
  queue.rows.forEach((row, i) => {
    const key = qdpArchiveAdminKey_(row);
    if (indexed.has(key)) throw new Error('Duplicate review entries were found. Start a new scan.');
    indexed.set(key, { row, number: i + 2 });
  });
  const seen = new Set(), validated = [];
  const lookups = body.changes.some(change => change.decision === 'Approve') ? qdpArchiveLookups_(ss) : null;
  body.changes.forEach(change => {
    const target = indexed.get(String(change.key));
    if (!target || seen.has(change.key) || qdpArchiveAdminRevision_(target.row) !== change.revision) {
      throw new Error('This review changed. Refresh before saving a decision.');
    }
    seen.add(change.key);
    const state = qdpArchiveAdminRowState_(target.row);
    if (!['pending', 'approved'].includes(state) && !(change.decision === 'Reject' && state === 'blocked')) {
      throw new Error('Only pending or approved suggestions can be changed.');
    }
    if (change.decision === 'Approve' && String(target.row[13]) !== lookups.signature) throw new Error('The Index changed since this scan. Start a new scan.');
    if (!['Approve', 'Reject', 'Pending'].includes(change.decision)) throw new Error('Choose approve, reject, or pending.');
    const proposed = change.proposedIds == null ? qdpArchiveIds_(target.row[8]) : change.proposedIds;
    if (!Array.isArray(proposed) || proposed.some(id => typeof id !== 'string') || new Set(proposed).size !== proposed.length) {
      throw new Error('Choose valid proposed associations.');
    }
    if (change.decision === 'Approve') {
      const old = qdpArchiveIds_(target.row[7]), candidates = qdpArchiveIds_(target.row[8]);
      const single = ['VenueID', 'PartyID', 'ExplicitQueer (Yes/No)'].includes(target.row[6]);
      if (!proposed.length || (single && proposed.length !== 1) ||
          old.some(id => !proposed.includes(id)) || proposed.some(id => !candidates.includes(id)) ||
          !proposed.some(id => !old.includes(id))) {
        throw new Error('Choose the additions to approve. Existing associations must be preserved.');
      }
    }
    validated.push({ ...target, decision: change.decision,
      proposed: change.decision === 'Approve' ? proposed.join(', ') : target.row[8] });
  });
  const rejected = validated.filter(item => item.decision === 'Reject');
  if (rejected.some(item => !qdpArchiveRejectedValues_(item.row).length)) {
    throw new Error('A rejected suggestion has no new association to reject. Start a fresh scan to replace that suggestion. Nothing was saved.');
  }
  const saved = rejected.length ? qdpArchiveSavedRejects_(ss) : null;
  const keys = new Set(saved ? saved.keys : []), output = [];
  for (const item of rejected) for (const value of qdpArchiveRejectedValues_(item.row)) {
    const key = qdpArchiveRejectKey_(item.row[4], item.row[6], value);
    if (keys.has(key)) continue;
    keys.add(key); output.push([String(item.row[4]).trim(), String(item.row[6]).trim(), value,
      item.row[2], item.row[5], new Date().toISOString(), item.row[12]]);
  }
  const cells = validated.flatMap(item => [
    { sheet: queue.sheet, row: item.number, column: 1, value: item.decision },
    { sheet: queue.sheet, row: item.number, column: 9, value: item.proposed }
  ]);
  for (const item of rejected) cells.push({sheet: queue.sheet, row: item.number, column: 2, value: 'Rejected (saved)'});
  const inline = qdpArchiveAdminPrepareInline_(ss, eventEdits, validated, queue);
  cells.push(...inline.cells);
  if (inline.editedEvents) qdpArchiveAdminMarkDirty_();
  if (typeof Sheets !== 'undefined') {
    // One atomic commit includes both review decisions and the rejection
    // ledger. Never reread SpreadsheetApp after an API write to infer success.
    const append = output.length ? [{appendCells: {sheetId: saved.sheet.getSheetId(),
      rows: output.map(row => ({values: row.map(value => ({userEnteredValue: {stringValue: String(value)}}))})),
      fields: 'userEnteredValue'}}] : [];
    qdpArchiveWriteCells_(ss, cells, append);
  } else {
    // Compatibility with the older spreadsheet-menu tools.
    if (output.length) saved.sheet.getRange(saved.sheet.getLastRow() + 1, 1, output.length, QDP_ARCHIVE_REVIEW_.rejectHeaders.length).setValues(output);
    qdpArchiveWriteCells_(ss, cells);
  }
  if (saved) {
    output.forEach(row => saved.rows.push(row));
    saved.keys = keys;
  }
  return { saved: validated.length, savedKeys: validated.map(item => qdpArchiveAdminKey_(item.row)),
    savedEventKeys: inline.savedEventKeys, editedEvents: inline.editedEvents, inlineApplied: inline.inlineApplied };
}

function qdpArchiveAdminBegin_(phase) {
  qdpArchiveAdminReady_();
  if (phase !== 'applying' && (typeof qdpLivePublish !== 'function' || typeof qdpArchivePublish !== 'function' || typeof qdpPublicPublishSaved_ !== 'function')) {
    throw new Error('Install the updated PublicData.gs before publishing archive updates.');
  }
  qdpArchiveAdminEnsureTrigger_();
  const job = { run: Utilities.getUuid(), phase, startedAt: new Date().toISOString(),
    applied: 0, livePublished: false, archivePublished: false, publishRequested: phase !== 'applying' };
  qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
  return job;
}

function qdpArchiveAdminRejects_(body) {
  const rows = qdpArchiveSavedRejects_(qdpArchiveSpreadsheet_()).rows;
  const offset = Math.max(0, Math.floor(Number(body.rejectOffset) || 0));
  return { rejectedTotal: rows.length, rejectOffset: offset,
    rejects: rows.slice(offset, offset + 30).map(row => ({
      key: qdpArchiveRejectKey_(row[0], row[1], row[2]), eventId: String(row[0]),
      field: String(row[1]), value: String(row[2]), title: String(row[4])
    })) };
}

function qdpAdminArchive_(body) {
  QDP_ARCHIVE_REQUEST_ = null;
  const action = String(body.action || '').trim().toLowerCase();
  if (action === 'admin.archive.bootstrap') return qdpArchiveAdminPage_(body);
  if (action === 'admin.archive.event.read') return qdpArchiveAdminReadEvent_(body);
  if (action === 'admin.archive.event.save') return qdpArchiveWithLock_(() => qdpArchiveAdminSaveEvent_(body));
  if (action === 'admin.archive.rejects') return qdpArchiveAdminRejects_(body);
  if (action === 'admin.archive.step') {
    qdpArchiveAdminWorker();
    return qdpArchiveAdminPage_(body);
  }
  const result = qdpArchiveWithLock_(() => {
    const ss = qdpArchiveSpreadsheet_();
    if (action === 'admin.archive.scan') {
      const options = qdpArchiveAdminOptions_(body);
      // Claim a new job before replacing the review. Any older worker or
      // publisher finishing later must not restore the superseded operation.
      const job = { run: Utilities.getUuid(), phase: 'scanning', startedAt: new Date().toISOString() };
      qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
      try {
        qdpArchiveAdminEnsureTrigger_();
        const scanned = qdpArchiveStartReview_(options);
        job.phase = scanned.finished ? 'ready' : 'scanning';
        qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
        if (scanned.finished) qdpArchiveAdminStopTriggers_();
        return scanned;
      } catch (error) {
        qdpArchiveAdminFail_(job, error);
        throw error;
      }
    }
    if (action === 'admin.archive.decide') return qdpArchiveAdminDecide_(body);
    if (action === 'admin.archive.save') {
      qdpArchiveAdminReady_();
      if (typeof Sheets === 'undefined') throw new Error('Enable Google Sheets API in Apps Script Services before saving changes together.');
      if (typeof qdpPublicPublishSaved_ !== 'function' && (typeof qdpLivePublish === 'function' || typeof qdpArchivePublish === 'function')) {
        throw new Error('Install PublicData.gs v7.4.22 and update the existing Apps Script deployment before saving. The older scheduled publisher cannot hold saved changes. Nothing was saved.');
      }
      const changes = Array.isArray(body.changes) ? body.changes.slice() : body.changes || [];
      if (!Array.isArray(changes) || changes.length > 5000) throw new Error('Save up to 5,000 suggestions at a time.');
      const eventEdits = body.eventEdits == null ? [] : body.eventEdits;
      if (!Array.isArray(eventEdits) || eventEdits.length > 200 || eventEdits.some(edit => !edit || typeof edit !== 'object' || Array.isArray(edit))) {
        throw new Error('Save up to 200 edited events at a time.');
      }
      const queue = qdpArchiveAdminQueue_(ss), submitted = new Set(changes.map(change => change.key));
      // Repair valid Reject decisions left by older saves that did not finish
      // writing their permanent rejection record.
      for (const row of queue.rows) {
        const key = qdpArchiveAdminKey_(row);
        if (row[0] === 'Reject' && row[1] !== 'Rejected (saved)' && !submitted.has(key) && qdpArchiveRejectedValues_(row).length) {
          changes.push({key, revision: qdpArchiveAdminRevision_(row), decision: 'Reject'});
        }
      }
      const cancelled = new Set(changes.filter(change => change.decision !== 'Approve').map(change => change.key));
      const applying = changes.some(change => change.decision === 'Approve') ||
        queue.rows.some(row => qdpArchiveAdminRowState_(row) === 'approved' && !cancelled.has(qdpArchiveAdminKey_(row)));
      if (!changes.length && !applying && !eventEdits.length) throw new Error('Edit an event or check at least one proposed change before saving.');
      // Ensure background work can be scheduled before writing decisions.
      if (applying) qdpArchiveAdminEnsureTrigger_();
      let saved;
      try {
        saved = changes.length || eventEdits.length ? qdpArchiveAdminDecide_({...body, changes}, eventEdits) : { saved: 0, savedKeys: [], savedEventKeys: [] };
      } catch (error) {
        if (applying) qdpArchiveAdminStopTriggers_();
        throw error;
      }
      if (applying) {
        const job = qdpArchiveAdminBegin_('applying');
        try {
          // Apply the first batch now, reusing the reads from the decision
          // save. Larger selections continue without publishing anything.
          const result = qdpArchiveApplyApprovals_();
          job.applied = (saved.inlineApplied || 0) + result.applied;
          if (!result.remaining) { job.phase = 'saved'; job.finishedAt = new Date().toISOString(); qdpArchiveAdminStopTriggers_(); }
          qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
        } catch (error) { qdpArchiveAdminFail_(job, error); }
      } else {
        qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, {run: Utilities.getUuid(), phase: 'saved', applied: 0,
          publishRequested: false, finishedAt: new Date().toISOString()});
      }
      return saved;
    }
    if (action === 'admin.archive.apply') {
      if (!qdpArchiveAdminQueue_(ss).rows.some(row => qdpArchiveAdminRowState_(row) === 'approved')) {
        throw new Error('Approve at least one suggestion first.');
      }
      qdpArchiveAdminBegin_('applying');
      return {};
    }
    if (action === 'admin.archive.publish') { qdpArchiveAdminBegin_('publishing-live'); return {}; }
    if (action === 'admin.archive.retry') {
      const job = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.jobKey);
      if (!job || job.phase !== 'failed') throw new Error('No failed operation needs a retry.');
      qdpArchiveAdminEnsureTrigger_();
      job.phase = job.retryPhase; delete job.error; delete job.leaseUntil;
      qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
      return {};
    }
    if (action === 'admin.archive.restore') {
      qdpArchiveAdminReady_();
      const saved = qdpArchiveSavedRejects_(ss);
      const rows = saved.sheet.getDataRange().getValues();
      let restored = 0;
      for (let i = rows.length - 1; i > 0; i--) {
        if (qdpArchiveRejectKey_(...rows[i].slice(0, 3)) === body.key) {
          saved.sheet.deleteRows(i + 1, 1); restored++;
        }
      }
      saved.rows = saved.rows.filter(row => qdpArchiveRejectKey_(...row.slice(0, 3)) !== body.key);
      saved.keys.delete(body.key);
      return { restored };
    }
    throw new Error('Unknown archive action.');
  });
  return { ...result, ...qdpArchiveAdminPage_(body) };
}

// The page runs batches immediately while open. A single temporary clock
// trigger continues the same durable job when the browser is closed.
function qdpArchiveAdminWorker() {
  QDP_ARCHIVE_REQUEST_ = null;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  let job, publishPhase = '';
  try {
    job = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.jobKey);
    if (!qdpArchiveAdminActive_(job)) { qdpArchiveAdminStopTriggers_(); return; }
    if (['publishing-live', 'publishing-archive'].includes(job.phase) && job.publishRequested !== true) {
      job.phase = 'saved'; delete job.leaseUntil;
      qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job); qdpArchiveAdminStopTriggers_(); return;
    }
    if (job.leaseUntil && Date.now() < job.leaseUntil) return;
    if (job.phase === 'scanning') {
      const result = qdpArchiveContinueReview_();
      if (result.finished) { job.phase = 'ready'; qdpArchiveAdminStopTriggers_(); }
    } else if (job.phase === 'applying') {
      const result = qdpArchiveApplyApprovals_();
      job.applied = (job.applied || 0) + result.applied;
      if (!result.remaining) { job.phase = 'saved'; job.finishedAt = new Date().toISOString(); qdpArchiveAdminStopTriggers_(); }
    } else {
      publishPhase = job.phase;
      // The public publishers acquire their own Script lock. Claim this
      // phase before releasing ours, so overlapping page/clock calls wait.
      job.leaseUntil = Date.now() + 7 * 60 * 1000;
      if (!job.dirtyRevision) job.dirtyRevision = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.dirtyKey);
    }
    qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
  } catch (error) {
    qdpArchiveAdminFail_(job, error);
  } finally { lock.releaseLock(); }
  if (!publishPhase) return;
  try {
    qdpPublicPublishSaved_(() => {
      if (publishPhase === 'publishing-live') qdpLivePublish(false);
      else qdpArchivePublish();
    });
    lock.waitLock(30000);
    try {
      const current = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.jobKey);
      if (!current || current.run !== job.run || current.phase !== publishPhase) return;
      delete current.leaseUntil;
      if (publishPhase === 'publishing-live') {
        current.livePublished = true; current.phase = 'publishing-archive';
      } else {
        current.archivePublished = true; current.phase = 'complete';
        current.finishedAt = new Date().toISOString();
        PropertiesService.getScriptProperties().setProperty(QDP_ARCHIVE_ADMIN_.publishKey, current.finishedAt);
        const dirty = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.dirtyKey);
        if (JSON.stringify(dirty) === JSON.stringify(current.dirtyRevision)) {
          PropertiesService.getScriptProperties().deleteProperty(QDP_ARCHIVE_ADMIN_.dirtyKey);
        }
        qdpArchiveAdminStopTriggers_();
      }
      qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, current);
    } finally { lock.releaseLock(); }
  } catch (error) {
    lock.waitLock(30000);
    try { qdpArchiveAdminFail_(job, error); } finally { lock.releaseLock(); }
  }
}

function qdpArchiveAdminFail_(job, error) {
  if (!job) return;
  const current = qdpArchiveAdminRead_(QDP_ARCHIVE_ADMIN_.jobKey);
  if (!current || current.run !== job.run) return;
  job.retryPhase = job.phase; job.phase = 'failed';
  job.error = String(error && error.message || error).slice(0, 1000);
  delete job.leaseUntil;
  qdpArchiveAdminWrite_(QDP_ARCHIVE_ADMIN_.jobKey, job);
  qdpArchiveAdminStopTriggers_();
}
