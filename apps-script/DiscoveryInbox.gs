/**
 * QDP Discovery Review v7.4.31.
 * Add this file; replace Core.gs with v7.4.31, and update the EXISTING web-app
 * deployment. Uses the installed Imports.gs, scraper.gs and PublicData.gs.
 * No triggers, new permissions, or sync queue are installed by this file.
 */
function qdpInboxAdmin_(body) {
  if (body.action === 'admin.discovery.snapshot') return qdpInboxSnapshot_();
  if (body.action === 'admin.discovery.flyers') return qdpInboxFlyers_(body.items);
  if (body.action === 'admin.discovery.import') return qdpInboxImport_(body.items);
  if (body.action === 'admin.discovery.publish') {
    const live = qdpLivePublish(false);
    const archive = qdpArchivePublish();
    return {live, archive, publishedAt: nowISO()};
  }
  throw new Error('Unknown Discovery Review action.');
}

function qdpInboxEvent_(table, row, calendar) {
  const c = table.col, tz = table.sheet.getParent().getSpreadsheetTimeZone();
  const value = key => qviRead_(row, c, key);
  const time = prefix => {
    try { return qviWall_(qviDate_(value(prefix + 'Date'), tz), qviTime_(value(prefix + 'Time'), tz), qviS_(value('timezone')) || 'America/New_York').toISOString(); }
    catch (_) { return ''; }
  };
  const fields = {description: stripAllQdpMetadata_(qviS_(value('description'))),
    lineup: qviS_(table.headers.includes('Lineup_Raw') ? row[table.headers.indexOf('Lineup_Raw')] : ''),
    start: time('start'), end: time('end'), flyer: qviS_(value('flyer'))};
  const id = qviS_(value('eventId')), calId = eventIdForApi_(qviS_(value('calId')));
  const live = calendar && calendar.get(calId);
  return {eventId: id, title: qviS_(value('title')), venueId: qviS_(value('venue')), location: qviS_(value('location')),
    sourceKey: qviS_(value('sourceKey')), calendarId: calId, publishToWeb: qviYes_(value('publish')), fields,
    revision: qdpAdminRevision_([id, fields, value('venue'), value('artists'), value('colls'), value('party')]),
    calendar: live ? {id: live.id, etag: live.etag, fields: {description: stripAllQdpMetadata_(live.description || ''),
      start: live.start && live.start.dateTime ? new Date(live.start.dateTime).toISOString() : '',
      end: live.end && live.end.dateTime ? new Date(live.end.dateTime).toISOString() : ''}} : null};
}

function qdpInboxSnapshot_() {
  const table = qviEventTable_(false), lookups = buildLookupMaps_(), calendar = new Map(), bounds = getWindowBounds();
  let pageToken = null, pages = 0;
  do {
    const page = Calendar.Events.list(CONFIG.CALENDAR_ID, {timeMin: bounds.timeMin, timeMax: bounds.timeMax,
      singleEvents: true, showDeleted: false, maxResults: 500, pageToken,
      fields: 'nextPageToken,items(id,summary,location,description,start,end,etag,updated)'});
    (page.items || []).forEach(event => calendar.set(event.id, event));
    pageToken = page.nextPageToken;
    if (++pages >= 5 && pageToken) throw new Error('The Calendar snapshot exceeds its bounded window. Narrow the configured window before reviewing.');
  } while (pageToken);
  const events = table.rows.map(row => qdpInboxEvent_(table, row, calendar)).filter(event => event.eventId);
  const intake = ss_().getSheetByName('Apify Import');
  const staged = intake ? qviTable_(intake) : {rows: [], index: {}};
  return {inboxVersion: 1, readAt: nowISO(), window: bounds, events,
    calendar: [...calendar.values()].map(event => ({id: event.id, title: event.summary || '', location: event.location || '',
      start: event.start, end: event.end, updatedAt: event.updated, description: stripAllQdpMetadata_(event.description || '')})),
    legacyDecisions: qdpDiscoveryTable_(false).records,
    intake: staged.rows.map(row => ({title: qviS_(row[staged.index['Title (internal)']]),
      date: row[staged.index.StartDate] instanceof Date ? Utilities.formatDate(row[staged.index.StartDate], 'America/New_York', 'yyyy-MM-dd') : qviS_(row[staged.index.StartDate]),
      location: qviS_(row[staged.index.Location]), sourceKey: qviS_(row[staged.index.ImportSourceKey]),
      result: qviS_(row[staged.index.Import_result])})).filter(row => row.title),
    references: {artists: Object.values(lookups.artistById).map(x => ({id: x.id, name: x.stage})),
      venues: Object.values(lookups.venueById).map(x => ({id: x.id, name: x.publicName || x.internal, address: x.address})),
      parties: Object.values(lookups.partyById).map(x => ({id: x.id, name: x.name})),
      artistAliases: lookups.artistAliases.map(({id, key, exactOnly}) => ({id, key, exactOnly})),
      venueAliases: lookups.venueAliases.map(({id, key, exactOnly}) => ({id, key, exactOnly})),
      partyAliases: lookups.partyAliases.map(({id, key, exactOnly}) => ({id, key, exactOnly})),
      collectiveAliases: lookups.collAliases.map(({id, key, exactOnly}) => ({id, key, exactOnly}))}};
}

function qdpInboxFlyer_(id, fields) {
  const folder = qdpScanFolder_();
  if (fields.Flyer_URL) {
    const match = String(fields.Flyer_URL).match(/[?&]id=([\w-]+)/) || String(fields.Flyer_URL).match(/\/d\/([\w-]+)/);
    if (!match) throw new Error('Use a saved QDP flyer URL or provide the original image.');
    const file = DriveApp.getFileById(match[1]), parents = file.getParents();
    let belongs = false; while (parents.hasNext()) if (parents.next().getId() === folder.getId()) belongs = true;
    if (!belongs || !/^image\//.test(file.getMimeType())) throw new Error('The saved flyer must be in the configured QDP flyer folder.');
    return {url: fields.Flyer_URL};
  }
  return qdpScanSaveImage_(folder, String(fields.RawFlyerURL || ''),
    'Discovery ' + id.slice(0, 16) + ' - ' + String(fields['Title (internal)'] || 'event'));
}

function qdpInboxFlyers_(items) {
  if (!Array.isArray(items) || items.length > 3) throw new Error('Preserve up to three flyers at a time.');
  return {flyers: items.map(item => {
    if (!/^[a-f0-9]{64}$/.test(item.id || '')) throw new Error('A proposal identity is required.');
    try { return {id: item.id, ...qdpInboxFlyer_(item.id, item.fields || {})}; }
    catch (error) { return {id: item.id, error: error.message}; }
  })};
}

function qdpInboxCell_(header, value, tz) {
  if (value instanceof Date) return qdpApifyCorrectionTimedCell_(value.toISOString(), tz, /Date$/.test(header));
  return {userEnteredValue: {stringValue: String(value == null ? '' : value)}};
}

function qdpInboxFieldsRevision_(fields) {
  const keys = ['Title (internal)', 'StartDate', 'EndDate', 'StartTime', 'EndTime', 'Timezone', 'Description',
    'Location', 'Lineup_Raw', 'Event_URL', 'Instagram_URL', 'RawFlyerURL', 'VenueID', 'ArtistIDs (comma-separated)', 'PartyID', 'HostCollectiveIDs (comma-separated)', 'ExplicitQueer (Yes/No)'];
  return qdpAdminRevision_(keys.map(key => String(fields[key] || '')));
}

function qdpInboxCalendar_(table, id, lookups) {
  const matches = table.rows.map((row, index) => ({row, number: index + 2})).filter(x => qviS_(qviRead_(x.row, table.col, 'eventId')) === id);
  if (matches.length !== 1) throw new Error('The EventID is missing or duplicated. Review the Events sheet.');
  const target = matches[0], c = table.col, row = target.row.slice(), original = row.slice();
  if (qviS_(qviRead_(row, c, 'calId'))) {
    qviPut_(row, c, 'publish', 'Yes');qviSetRow_(table.sheet, target.number, row, original);
    return {calendarId: qviRead_(row, c, 'calId'), calendarCreated: true};
  }
  const read = key => qviRead_(row, c, key), tz = table.sheet.getParent().getSpreadsheetTimeZone();
  const draft = qviDraft_({title: read('title'), startDate: read('startDate'), startTime: read('startTime'), endDate: read('endDate'), endTime: read('endTime'),
    timezone: read('timezone'), description: read('description'), venueId: read('venue'), artists: read('artists'), colls: read('colls'),
    party: read('party'), explicit: read('explicit'), flyer: read('flyer'), url: read('url'), location: read('location')}, tz);
  qviValidateIds_(draft, lookups);
  const createId = read('createId');
  if (!createId) throw new Error('The saved Calendar retry identity is missing.');
  const body = qviCalendarBody_(draft, row, c, lookups, createId);
  const result = qviCreateCalendar_(body), event = result.event;
  qviPut_(row, c, 'calId', event.id); qviPut_(row, c, 'calUpdated', '');
  qviPut_(row, c, 'description', body.description); qviPut_(row, c, 'edited', nowISO());
  qviPut_(row, c, 'synced', result.recovered ? '' : nowISO());
  qviPut_(row, c, 'notes', result.recovered ? 'Recovered the Discovery Review Calendar creation.' : 'Created by Discovery Review.');
  qviPut_(row, c, 'publish', 'Yes');
  qviSetRow_(table.sheet, target.number, row, original);
  target.row.splice(0, target.row.length, ...row);
  return {calendarId: event.id, calendarCreated: true, recovered: result.recovered};
}

function qdpInboxImport_(items) {
  if (!FLAGS.PUSH_ENABLED) throw new Error('Calendar writes are disabled.');
  if (!Array.isArray(items) || !items.length || items.length > 5) throw new Error('Import between one and five proposals.');
  const prepared = [], results = [];
  // Network downloads happen before the shared write lock. Revisions are checked inside it.
  for (const item of items) {
    if (!/^[a-f0-9]{64}$/.test(item.id || '') || !['event', 'correction'].includes(item.kind)) throw new Error('Invalid proposal.');
    try {
      if (item.kind === 'event') {
        const ready = qdpScanValidate_({...item.fields, Review: 'Include', RawFlyerURL: item.fields.RawFlyerURL || item.fields.Flyer_URL}, ss_().getSpreadsheetTimeZone());
        if (!ready.ok) throw new Error(ready.reason);
        if (!qviS_(item.fields.Lineup_Raw) || /^(tba|tbd|unknown|to be announced)$/i.test(qviS_(item.fields.Lineup_Raw))) throw new Error('A confirmed named lineup is required.');
        item.savedFlyer = qdpInboxFlyer_(item.id, item.fields).url;
      } else if (item.changes && item.changes.flyer) {
        item.savedFlyer = qdpInboxFlyer_(item.id, {'Title (internal)': item.eventId, RawFlyerURL: item.changes.flyer}).url;
      }
      prepared.push(item);
    } catch (error) { results.push({id: item.id, error: error.message}); }
  }
  if (!prepared.length) return {results};
  return qdpWithWriteLock_(() => {
    const table = qviEventTable_(true), c = table.col, lookups = buildLookupMaps_(), existing = {ids: new Set()}, tz = ss_().getSpreadsheetTimeZone();
    // Read only ID columns when checking uniqueness across historical tabs.
    ss_().getSheets().filter(sheet => sheet.getName() === CONFIG.SHEET_EVENTS || /archive/i.test(sheet.getName())).forEach(sheet => {
      if (sheet.getLastRow() < 2) return;
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], column = headers.indexOf('EventID') + 1;
      if (column) sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues().forEach(row => {if (row[0]) existing.ids.add(String(row[0]));});
    });
    const plans = [], append = [], sourceIndex = new Map();
    table.rows.forEach((row, i) => {
      const key = qviS_(qviRead_(row, c, 'sourceKey'));
      if (key) {if (!sourceIndex.has(key)) sourceIndex.set(key, []);sourceIndex.get(key).push({row, number: i + 2});}
    });
    for (const item of prepared) {
      try {
        if (item.kind === 'correction') {results.push({id: item.id, ...qdpInboxCorrect_(item, table)});continue;}
        const key = 'qdp-discovery:v1:' + item.id, prior = sourceIndex.get(key) || [];
        if (prior.length > 1) throw new Error('This discovery source is duplicated in Events. Resolve it before retrying.');
        if (prior.length) {
          const savedSnapshot = JSON.parse(qviRead_(prior[0].row, c, 'snapshot') || '{}');
          if (savedSnapshot.fieldsRevision && savedSnapshot.fieldsRevision !== qdpInboxFieldsRevision_(item.fields)) {
            results.push({id: item.id, eventId: qviRead_(prior[0].row, c, 'eventId'), sheetSaved: true,
              error: 'This proposal already has an Events draft with different saved fields. Edit that existing record, then retry its remaining steps.'});
            continue;
          }
          plans.push({item, eventId: qviRead_(prior[0].row, c, 'eventId')});continue;
        }
        const f = item.fields, detected = detectIdsByKeywords_([f['Title (internal)'], f.Description, f.Location, f.Lineup_Raw].filter(Boolean).join('\n'), lookups);
        const ids = qdpResolveEventIds_({venue: f.VenueID || '', artists: f['ArtistIDs (comma-separated)'] || '', colls: f['HostCollectiveIDs (comma-separated)'] || '', party: f.PartyID || ''},
          parseIdsFromDescription_(f.Description || ''), detected, lookups, {owned: [], pending: []});
        const draft = qviDraft_({title: f['Title (internal)'], startDate: f.StartDate, startTime: f.StartTime, endDate: f.EndDate, endTime: f.EndTime,
          timezone: f.Timezone || 'America/New_York', description: f.Description, venueId: ids.venue, artists: ids.artists, colls: ids.colls,
          party: ids.party, explicit: f['ExplicitQueer (Yes/No)'] || 'No', flyer: item.savedFlyer, url: f.Event_URL || f.Instagram_URL,
          location: f.Location, key, snapshot: JSON.stringify({discovery: item.discovery, fieldsRevision: qdpInboxFieldsRevision_(f)})}, tz);
        qviValidateIds_(draft, lookups);
        const same = table.rows.filter(row => {
          const event = qdpInboxEvent_(table, row);
          return normalizeKey_(event.title) === normalizeKey_(draft.title) && event.fields.start.slice(0, 10) === draft.start.toISOString().slice(0, 10)
            && (draft.venueId ? event.venueId === draft.venueId : normalizeKey_(event.location) === normalizeKey_(draft.location));
        });
        if (same.length) {
          if (same.length > 1) throw new Error('Multiple existing listings match this discovery. Resolve them before importing.');
          const event = qdpInboxEvent_(table, same[0]);
          if (Math.abs(Date.parse(event.fields.start) - draft.start) >= 60000) throw new Error('An existing event has the same title, venue and date with a different time. Review it as a correction or confirm the distinct event manually.');
          results.push({id: item.id, eventId: event.eventId, alreadyPublished: event.publishToWeb && !!event.calendarId,
            calendarCreated: !!event.calendarId, error: event.publishToWeb && event.calendarId ? undefined : 'An existing QDP draft matches this discovery. Finish its existing Events record instead of adding another.'});
          continue;
        }
        // Catch Magic/Calendar additions that have not reached the Index yet.
        const live = Calendar.Events.list(CONFIG.CALENDAR_ID, {timeMin: new Date(+draft.start - 60000).toISOString(), timeMax: new Date(+draft.start + 60000).toISOString(),
          singleEvents: true, showDeleted: false, maxResults: 250, fields: 'items(id,summary,start,location)'});
        const duplicate = (live.items || []).find(event => event.start && event.start.dateTime &&
          Math.abs(+new Date(event.start.dateTime) - draft.start) < 60000 && normalizeKey_(stripIdentityEmojis_(event.summary || '')) === normalizeKey_(draft.title) &&
          (!event.location || normalizeKey_(event.location) === normalizeKey_(draft.location) || (draft.venueId && detectIdsByKeywords_(event.location, lookups).venue === draft.venueId)));
        if (duplicate) throw new Error('This event already exists in Calendar. Run Pull to use its existing record.');
        const id = qviEventId_(draft, existing), row = Array(table.headers.length).fill('');
        const values = {eventId: id, title: draft.title, startDate: draft.start, startTime: draft.start, endDate: draft.end, endTime: draft.end,
          timezone: draft.timezone, description: draft.description, venue: draft.venueId, artists: draft.artists.join(', '), colls: draft.colls.join(', '), party: draft.party,
          explicit: draft.explicit, flyer: draft.flyer, url: draft.url, location: draft.location, publish: 'No', edited: nowISO(), sourceKey: key,
          snapshot: draft.snapshot, createId: 'qdp' + qviHash_(ss_().getId() + '|' + key).slice(0, 48)};
        Object.keys(values).forEach(name => qviPut_(row, c, name, values[name]));
        const lineup = table.headers.indexOf('Lineup_Raw'); if (lineup >= 0) row[lineup] = f.Lineup_Raw;
        qviApplyDerived_(row, c, draft, lookups, true);
        append.push(row);plans.push({item, eventId: id});sourceIndex.set(key, [{row}]);table.rows.push(row);
      } catch (error) {results.push({id: item.id, error: error.message});}
    }
    if (append.length) {
      Sheets.Spreadsheets.batchUpdate({requests: [{appendCells: {sheetId: table.sheet.getSheetId(),
        rows: append.map(row => ({values: row.map((value, i) => qdpInboxCell_(table.headers[i], value, tz))})),
        fields: 'userEnteredValue,userEnteredFormat.numberFormat'}}]}, ss_().getId());
    }
    const fresh = qviEventTable_(false);
    for (const plan of plans) {
      try {results.push({id: plan.item.id, eventId: plan.eventId, sheetSaved: true, ...qdpInboxCalendar_(fresh, plan.eventId, lookups)});}
      catch (error) {results.push({id: plan.item.id, eventId: plan.eventId, sheetSaved: true, error: error.message});}
    }
    return {results};
  }, 20000, 'Import Discovery Review selections');
}

function qdpInboxReceipts_() {
  const ss = ss_(); let sheet = ss.getSheetByName('QDP_Discovery_Receipts');
  if (!sheet) {sheet = ss.insertSheet('QDP_Discovery_Receipts');sheet.getRange(1, 1, 1, 3).setValues([['ProposalID', 'Receipt', 'UpdatedAt']]);sheet.setFrozenRows(1);}
  const values = sheet.getDataRange().getValues();
  if (JSON.stringify(values[0].slice(0, 3)) !== JSON.stringify(['ProposalID', 'Receipt', 'UpdatedAt'])) throw new Error('Discovery receipts have unexpected headers.');
  return {sheet, rows: new Map(values.slice(1).map((row, i) => [String(row[0]), {number: i + 2, value: JSON.parse(row[1])}]))};
}

function qdpInboxCorrect_(item, table) {
  const matches = table.rows.map((row, i) => ({row, number: i + 2})).filter(x => qviS_(qviRead_(x.row, table.col, 'eventId')).toUpperCase() === String(item.eventId || '').toUpperCase());
  if (matches.length !== 1) throw new Error('The correction target is missing or duplicated in Events.');
  const target = matches[0], changes = item.changes, keys = Object.keys(changes || {}), tz = ss_().getSpreadsheetTimeZone();
  if (!keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(QDP_APIFY_CORRECTION_LABELS_, key))) throw new Error('Select the correction fields to apply.');
  const desired = {};
  keys.forEach(key => {
    if (typeof changes[key] !== 'string' || changes[key].length > 50000) throw new Error('Invalid correction field.');
    if (key === 'start' || key === 'end') {
      const local = qdpApifyCorrectionTime_(changes[key]);desired[key] = qviWall_(local.slice(0, 10), local.slice(11), 'America/New_York').toISOString();
    } else desired[key] = changes[key];
  });
  if ('flyer' in desired) desired.flyer = item.savedFlyer;
  const current = qdpInboxEvent_(table, target.row), fingerprint = qdpAdminRevision_([item.eventId, changes]), receipts = qdpInboxReceipts_();
  const saved = receipts.rows.get(item.id);let receipt = saved && saved.value;
  const receiptRow = saved ? saved.number : receipts.sheet.getLastRow() + 1;
  const put = () => receipts.sheet.getRange(receiptRow, 1, 1, 3).setValues([[item.id, JSON.stringify(receipt), nowISO()]]);
  const shared = keys.filter(key => QDP_APIFY_CALENDAR_FIELDS_.includes(key));
  const calendarId = eventIdForApi_(current.calendarId);
  let calendar = shared.length ? qdpApifyCorrectionReadCalendar_(calendarId) : null;
  const calendarValue = key => key === 'description' ? stripAllQdpMetadata_(calendar.description || '') : new Date(calendar[key].dateTime).toISOString();
  if (!receipt) {
    if (!item.baseline || item.baseline.eventId !== current.eventId) throw new Error('Load the current listing in Discovery Review before applying this correction.');
    for (const key of keys) if (String(item.baseline.fields[key] || '') !== String(current.fields[key] || '')) throw new Error('The listing changed since review. Load its current details before approving again.');
    for (const key of shared) {
      if (!item.baseline.calendar || item.baseline.calendar.id !== calendarId || String(item.baseline.calendar.fields[key] || '') !== calendarValue(key)) throw new Error('Calendar changed since review. Load its current details before approving again.');
    }
    receipt = {fingerprint, eventId: current.eventId, phase: 'planned', before: {}, desired: {}, calendarBefore: {}, calendarId};
    keys.forEach(key => {receipt.before[key] = qdpAdminRevision_([current.fields[key]]);receipt.desired[key] = qdpAdminRevision_([desired[key]]);});
    shared.forEach(key => {receipt.calendarBefore[key] = qdpAdminRevision_([calendarValue(key)]);});
    put();
  }
  if (receipt.fingerprint !== fingerprint) throw new Error('This correction already began with different selected values. Review its existing Events record before changing the proposal.');
  if (receipt.phase === 'complete') return {eventId: current.eventId, sheetSaved: true, calendarCreated: true, correction: true, recovered: true};
  const next = target.row.slice(), c = table.col, requests = [];
  for (const key of keys) {
    const hash = qdpAdminRevision_([current.fields[key]]);
    if (hash !== receipt.before[key] && hash !== receipt.desired[key]) throw new Error('Events ' + key + ' changed during the correction. Review before retrying.');
    if (key === 'start' || key === 'end') {qviPut_(next, c, key + 'Date', new Date(desired[key]));qviPut_(next, c, key + 'Time', new Date(desired[key]));}
    else if (key === 'description') qviPut_(next, c, 'description', desired[key]);
    else if (key === 'flyer') qviPut_(next, c, 'flyer', desired[key]);
    else {const col = table.headers.indexOf('Lineup_Raw');if (col < 0) throw new Error('Events needs Lineup_Raw.');next[col] = desired[key];}
  }
  const resulting = qdpInboxEvent_(table, next);
  qdpApifyCorrectionCheckRange_(resulting.fields.start, resulting.fields.end);
  const formulas = table.sheet.getRange(target.number, 1, 1, table.headers.length).getFormulas()[0];
  const touched = next.flatMap((value, i) => !sheetValuesEqual_(value, target.row[i]) ? [i + 1] : []);
  touched.forEach(column => {if (formulas[column - 1]) throw new Error('A selected correction field is a formula.');});
  const rules = qdpApplyEventSaveRules_(next, table.headers, buildLookupMaps_(), {original: target.row, formulas, touched,
    markEdited: true, recordManual: true, refreshTitle: true, refreshIndicators: true});
  qviSetRow_(table.sheet, target.number, rules.row, target.row);
  receipt.phase = 'sheet';put();
  if (shared.length) {
    const patch = {};
    for (const key of shared) {
      const live = calendarValue(key), liveHash = qdpAdminRevision_([live]);
      if (liveHash === receipt.desired[key]) continue;
      if (liveHash !== receipt.calendarBefore[key]) throw new Error('Calendar ' + key + ' changed during this correction. Review before retrying.');
      if (key === 'description') {const footer = String(calendar.description || '').slice(live.length).trim();patch.description = [desired[key], footer].filter(Boolean).join('\n\n');}
      else patch[key] = {dateTime: desired[key], timeZone: 'America/New_York'};
    }
    if (Object.keys(patch).length) Calendar.Events.patch(patch, CONFIG.CALENDAR_ID, calendarId, {sendUpdates: 'none'}, {'If-Match': calendar.etag});
  }
  receipt.phase = 'complete';put();
  return {eventId: current.eventId, sheetSaved: true, calendarCreated: true, correction: true};
}
