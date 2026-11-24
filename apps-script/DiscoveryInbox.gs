/**
 * QDP Discovery Review v7.4.35. Uses ArchiveReview.gs v7.4.26 for event fields.
 * Replace this file, keep Core.gs v7.4.31 or later, and update the EXISTING web-app
 * deployment. Uses the installed Imports.gs, scraper.gs and PublicData.gs.
 * No triggers, new permissions, or sync queue are installed by this file.
 */
const QDP_INBOX_FIELD_KEYS_ = Object.freeze({
  Title:'Title (internal)','Public title':'Title_Public (auto w/ emojis)',Description:'description',
  'Raw lineup':'lineup',Status:'Status','Start date':'start','Start time':'start','End date':'end','End time':'end',
  'Time zone':'Timezone',Venue:'VenueID',Location:'Location',Address:'Address (from Venue)',
  Neighborhood:'Neighborhood (from Venue)',Artists:'ArtistIDs (comma-separated)',
  Collectives:'HostCollectiveIDs (comma-separated)',Party:'PartyID','Explicitly queer event':'ExplicitQueer (Yes/No)',
  'Show on website':'Publish_To_Web','Event link':'Event_URL','Ticket link':'Ticket_URL','Source link':'Source_URL',
  'Instagram link':'Instagram_URL','Flyer image URL':'flyer','Original flyer link':'RawFlyerURL','Photo URLs':'PhotoURLs'
});
function qdpInboxFieldKey_(field) { return QDP_INBOX_FIELD_KEYS_[field.label] || field.key; }

function qdpInboxAdmin_(body) {
  if (body.action === 'admin.discovery.snapshot') return qdpInboxSnapshot_(body);
  if (body.action === 'admin.discovery.flyers') return qdpInboxFlyers_(body.items);
  if (body.action === 'admin.discovery.import') {
    if (body.phase === 'capabilities') return {importVersion: 2, batchSize: 20, optionalFlyer: true, optionalDetails: true};
    return qdpInboxImport_(body.items, body.phase);
  }
  if (body.action === 'admin.discovery.publish') {
    return qdpWithWriteLock_(() => {
      // Recover lost creation receipts before Pull can mistake them for new
      // Calendar additions. This only reads Calendar; it never creates an event.
      qdpInboxReconcileCalendarDrafts_();
      const pull = pullCalendarToSheet_Full();
      const live = qdpLivePublish(false), archive = qdpArchivePublish();
      return {pull, live, archive, publishedAt: nowISO()};
    }, 20000, 'Match and publish Discovery Review imports');
  }
  throw new Error('Unknown Discovery Review action.');
}

function qdpInboxEvent_(table, row, calendar, sheetTz) {
  const c = table.col, tz = sheetTz || table.sheet.getParent().getSpreadsheetTimeZone();
  const value = key => qviRead_(row, c, key);
  const time = prefix => {
    try { return qviWall_(qviDate_(value(prefix + 'Date'), tz), qviTime_(value(prefix + 'Time'), tz), qviS_(value('timezone')) || 'America/New_York').toISOString(); }
    catch (_) { return ''; }
  };
  const editable = typeof qdpArchiveAdminEventFields_ === 'function' ? qdpArchiveAdminEventFields_({
    layout: {headers: table.headers}, row, formulas: table.formulas?.get(row) || []}) : [];
  const definitions = new Map();
  editable.forEach(({column, value, ...field}) => {
    const key = qdpInboxFieldKey_(field), previous = definitions.get(key);
    definitions.set(key, {...field, key, type: ['start','end'].includes(key) ? 'datetime-local' : field.type,
      readOnly: Boolean(field.readOnly || previous?.readOnly)});
  });
  const fields = {...Object.fromEntries(editable.map(field => [qdpInboxFieldKey_(field), field.value])),
    description: stripAllQdpMetadata_(qviS_(value('description'))),
    lineup: qviS_(table.headers.includes('Lineup_Raw') ? row[table.headers.indexOf('Lineup_Raw')] : ''),
    start: time('start'), end: time('end'), flyer: qviS_(value('flyer'))};
  const id = qviS_(value('eventId')), calId = eventIdForApi_(qviS_(value('calId')));
  const live = calendar && calendar.get(calId);
  return {eventId: id, title: qviS_(value('title')), venueId: qviS_(value('venue')), location: qviS_(value('location')),
    sourceUrl: qviS_(value('url')), instagramUrl: qviS_(row[table.headers.indexOf('Instagram_URL')]),
    sourceKey: qviS_(value('sourceKey')), calendarId: calId, publishToWeb: qviYes_(value('publish')), fields,
    editableFields: [...definitions.values()],
    revision: qdpAdminRevision_([id, fields, value('venue'), value('artists'), value('colls'), value('party')]),
    calendar: live ? {id: live.id, etag: live.etag, fields: {description: stripAllQdpMetadata_(live.description || ''),
      start: live.start && live.start.dateTime ? new Date(live.start.dateTime).toISOString() : '',
      end: live.end && live.end.dateTime ? new Date(live.end.dateTime).toISOString() : ''},
      rawFields: Object.fromEntries(['summary','location','description','start','end','colorId'].map(key => [key, qdpInboxCalendarValue_(live, key)]))} : null};
}

function qdpInboxCalendarValue_(event, key) {
  const value = event[key];
  if (key === 'start' || key === 'end') return value?.dateTime ? JSON.stringify({dateTime: new Date(value.dateTime).toISOString(), timeZone: value.timeZone || ''}) : JSON.stringify(value || {});
  return String(value || '');
}

function qdpInboxSnapshot_(body) {
  const table = qviEventTable_(false), lookups = buildLookupMaps_(), calendar = new Map(), bounds = getWindowBounds();
  if (table.rows.length && typeof qdpArchiveAdminEventFields_ === 'function') {
    const formulas = table.sheet.getRange(2, 1, table.rows.length, table.headers.length).getFormulas();
    table.formulas = new Map(table.rows.map((row, i) => [row, formulas[i]]));
  }
  let pageToken = null, pages = 0;
  do {
    const page = Calendar.Events.list(CONFIG.CALENDAR_ID, {timeMin: bounds.timeMin, timeMax: bounds.timeMax,
      singleEvents: true, showDeleted: false, maxResults: 500, pageToken,
      fields: 'nextPageToken,items(id,summary,location,description,start,end,colorId,etag,updated)'});
    (page.items || []).forEach(event => calendar.set(event.id, event));
    pageToken = page.nextPageToken;
    if (++pages >= 5 && pageToken) throw new Error('The Calendar snapshot exceeds its bounded window. Narrow the configured window before reviewing.');
  } while (pageToken);
  const events = table.rows.map(row => qdpInboxEvent_(table, row, calendar)).filter(event => event.eventId);
  const intake = ss_().getSheetByName('Apify Import');
  const staged = intake ? qviTable_(intake) : {rows: [], index: {}};
  const snapshot = {inboxVersion: 1, discoveryVersion: '7.4.35', frameUploadVersion: 1, imageUploadVersion: 1, readAt: nowISO(), window: bounds, events,
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
  if (!body || body.mode !== 'delta') return snapshot;
  const known = body.known || {}, hashes = {};
  ['events','calendar','intake'].forEach(kind => {
    hashes[kind] = {};
    snapshot[kind] = snapshot[kind].filter(value => {
      if (kind === 'intake') value.snapshotId = qdpInboxHash_(JSON.stringify([value.title,value.date,value.location,value.sourceKey]));
      const id = kind === 'events' ? value.eventId : kind === 'calendar' ? value.id : value.snapshotId;
      const hash = qdpInboxHash_(JSON.stringify(value));hashes[kind][id] = hash;
      return !known[kind] || known[kind][id] !== hash;
    });
  });
  hashes.references = qdpInboxHash_(JSON.stringify(snapshot.references));
  if (known.references === hashes.references) delete snapshot.references;
  return {...snapshot, deltaVersion: 1, hashes};
}

function qdpInboxHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(value => ('0' + (value & 255).toString(16)).slice(-2)).join('');
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
    try { return {id: item.id, ...(item.frame ? qdpInboxFrameFlyer_(item.id, item.frame) : qdpInboxFlyer_(item.id, item.fields || {}))}; }
    catch (error) { return {id: item.id, error: error.message}; }
  })};
}

/** Original decoded frames only; no arbitrary folder, file ID, or rendering operation. */
function qdpInboxFrameFlyer_(id, frame) {
  const source = frame && frame.source, still = source && source.kind === 'image';
  if (!source || source.verified !== true || !/^https:\/\/(?:www\.|m\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\//.test(source.postUrl || '') ||
    (!still && (!Number.isFinite(source.seconds) || source.seconds < 0 || source.seconds > 10800)) ||
    !/^[a-f0-9]{64}$/.test(frame.sha256 || '') || typeof frame.base64 !== 'string' || frame.base64.length > 8 * 1024 * 1024) {
    throw new Error('A verified original video frame, source and checksum are required.');
  }
  const bytes = Utilities.base64Decode(frame.base64), b = bytes.slice(0,12).map(n => n & 255);
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) throw new Error('Use an original frame up to 6 MB.');
  const jpeg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  const png = b.slice(0,8).join(',') === '137,80,78,71,13,10,26,10';
  const gif = /^GIF8[79]a$/.test(String.fromCharCode.apply(null,b.slice(0,6)));
  const webp = String.fromCharCode.apply(null,b.slice(0,4)) === 'RIFF' && String.fromCharCode.apply(null,b.slice(8,12)) === 'WEBP';
  if (!jpeg && !png && !(still && (gif || webp))) throw new Error('Use original JPEG/PNG frames or JPEG/PNG/GIF/WebP post images.');
  const extension = jpeg ? '.jpg' : png ? '.png' : gif ? '.gif' : '.webp';
  const mime = jpeg ? 'image/jpeg' : png ? 'image/png' : gif ? 'image/gif' : 'image/webp';
  const hash = data => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data)
    .map(n => ('0' + (n & 255).toString(16)).slice(-2)).join('');
  if (hash(bytes) !== frame.sha256) throw new Error('The original frame checksum does not match.');
  const folder = qdpScanFolder_(), name = 'Discovery ' + id + (still ? ' image ' : ' frame ') + frame.sha256 + extension;
  const matches = folder.getFilesByName(name);let file;
  while (matches.hasNext()) {const existing = matches.next();if (hash(existing.getBlob().getBytes()) === frame.sha256) {file = existing;break;}}
  if (!file) file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  if (hash(file.getBlob().getBytes()) !== frame.sha256) throw new Error('Saved frame verification failed.');
  const resourceKey = file.getResourceKey();
  return {url: 'https://drive.google.com/uc?export=view&id=' + file.getId() + (resourceKey ? '&resourcekey=' + encodeURIComponent(resourceKey) : ''),
    sha256: frame.sha256, fromVideo: !still};
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

function qdpInboxReconcileCalendarDrafts_() {
  const table = qviEventTable_(false), c = table.col;
  table.rows.forEach((original, i) => {
    const read = key => qviRead_(original, c, key), createId = qviS_(read('createId'));
    if (read('calId') || !createId || !/^qdp-discovery:v1:/.test(qviS_(read('sourceKey')))) return;
    let event;
    try {event = Calendar.Events.get(CONFIG.CALENDAR_ID, createId);}
    catch (error) {if (/\b404\b|\b410\b|not found|gone/i.test(String(error.message))) return;throw error;}
    qviOwnCalendarEvent_(event, {extendedProperties: {private: {qdpEventId: qviS_(read('eventId')), qdpSpreadsheet: ss_().getId()}}});
    const row = original.slice();qviPut_(row, c, 'calId', event.id);qviPut_(row, c, 'calUpdated', '');
    // Keep Publish_To_Web as saved; failed proposals still need confirmation.
    qviSetRow_(table.sheet, i + 2, row, original);
  });
}

function qdpInboxCreateCalendarBatch_(bodies) {
  const results = [], url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(CONFIG.CALENDAR_ID) + '/events?sendUpdates=none';
  if (!bodies.length) return results;
  const authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  // Parallel groups of ten avoid a read-before-insert round trip per event.
  // Every body uses the CalendarCreateId already persisted in its Events row.
  for (let offset = 0; offset < bodies.length; offset += 10) {
    const batch = bodies.slice(offset, offset + 10); let responses;
    try {
      responses = UrlFetchApp.fetchAll(batch.map(body => ({url, method: 'post', contentType: 'application/json',
        headers: {Authorization: authorization}, payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: false})));
    } catch (_) {
      batch.forEach(() => results.push({error: 'Calendar batch response was not confirmed. Retry to recover the saved creation IDs.'}));
      continue;
    }
    batch.forEach((body, index) => {
      try {
        const response = responses[index], code = response.getResponseCode();let event;
        try {event = JSON.parse(response.getContentText());} catch (_) {throw new Error('Calendar returned an unreadable response. Retry to recover this event.');}
        if (code === 409) {
          results.push({event: qviOwnCalendarEvent_(Calendar.Events.get(CONFIG.CALENDAR_ID, body.id), body), recovered: true});
        } else if (code >= 200 && code < 300 && event.id === body.id) {
          results.push({event: qviOwnCalendarEvent_(event, body), recovered: false});
        } else throw new Error('Calendar ' + code + ': ' + String(event.error && event.error.message || 'creation was not confirmed').slice(0, 300));
      } catch (error) {results.push({error: error.message});}
    });
  }
  return results;
}

function qdpInboxCalendarBatch_(table, plans, lookups) {
  const c = table.col, targets = [], pending = [], results = [], byId = new Map();
  table.rows.forEach(row => {const id = qviS_(qviRead_(row, c, 'eventId'));if (!byId.has(id)) byId.set(id, []);byId.get(id).push(row);});
  for (const plan of plans) {
    try {
      const matches = byId.get(plan.eventId) || [];
      if (matches.length !== 1) throw new Error('The EventID is missing or duplicated. Review the Events sheet.');
      const original = matches[0], row = original.slice(), read = key => qviRead_(row, c, key);
      const target = {plan, original, row};
      if (qviS_(read('calId'))) {
        target.result = {calendarId: read('calId'), calendarCreated: true};qviPut_(row, c, 'publish', 'Yes');targets.push(target);continue;
      }
      const draft = qviDraft_({title: read('title'), startDate: read('startDate'), startTime: read('startTime'), endDate: read('endDate'), endTime: read('endTime'),
        timezone: read('timezone'), description: read('description'), venueId: read('venue'), artists: read('artists'), colls: read('colls'),
        party: read('party'), explicit: read('explicit'), flyer: read('flyer'), url: read('url'), location: read('location')}, table.sheet.getParent().getSpreadsheetTimeZone());
      qviValidateIds_(draft, lookups);
      if (!read('createId')) throw new Error('The saved Calendar retry identity is missing.');
      target.body = qviCalendarBody_(draft, row, c, lookups, read('createId'));pending.push(target);
    } catch (error) {results.push({id: plan.item.id, eventId: plan.eventId, sheetSaved: true, error: error.message});}
  }
  const created = qdpInboxCreateCalendarBatch_(pending.map(target => target.body));
  pending.forEach((target, index) => {
    const result = created[index] || {error: 'Calendar did not confirm this event. Retry safely.'};
    if (result.error) {results.push({id: target.plan.item.id, eventId: target.plan.eventId, sheetSaved: true, error: result.error});return;}
    qviPut_(target.row, c, 'calId', result.event.id);qviPut_(target.row, c, 'calUpdated', '');
    qviPut_(target.row, c, 'description', target.body.description);qviPut_(target.row, c, 'edited', nowISO());
    qviPut_(target.row, c, 'synced', result.recovered ? '' : nowISO());
    qviPut_(target.row, c, 'notes', result.recovered ? 'Recovered the Discovery Review Calendar creation.' : 'Created by Discovery Review.');
    qviPut_(target.row, c, 'publish', 'Yes');
    target.result = {calendarId: result.event.id, calendarCreated: true, recovered: result.recovered};targets.push(target);
  });
  if (!targets.length) return results;
  // Re-read once after the network batch. Preserve intervening edits and every
  // formula, then persist only changed receipt cells in one Sheets request.
  const fresh = qviEventTable_(false), index = new Map(), requests = [], saved = [];
  fresh.rows.forEach((row, i) => {const id = qviS_(qviRead_(row, fresh.col, 'eventId'));if (!index.has(id)) index.set(id, []);index.get(id).push({row, number: i + 2});});
  const formulas = fresh.rows.length ? fresh.sheet.getRange(2, 1, fresh.rows.length, fresh.headers.length).getFormulas() : [];
  for (const target of targets) {
    try {
      const matches = index.get(target.plan.eventId) || [];
      if (matches.length !== 1 || matches[0].row.some((value, i) => !sheetValuesEqual_(value, target.original[i]))) throw new Error('This Events row changed during Calendar creation. Its edits were retained; review and retry.');
      const current = matches[0], changed = target.row.flatMap((value, i) => sheetValuesEqual_(value, target.original[i]) ? [] : [i]);
      if (changed.some(i => formulas[current.number - 2][i])) throw new Error('A Calendar receipt column is a formula. Review the Events row before retrying.');
      changed.forEach(i => requests.push({updateCells: {start: {sheetId: fresh.sheet.getSheetId(), rowIndex: current.number - 1, columnIndex: i},
        rows: [{values: [qdpInboxCell_(fresh.headers[i], target.row[i], fresh.sheet.getParent().getSpreadsheetTimeZone())]}], fields: 'userEnteredValue'}}));
      saved.push(target);
    } catch (error) {results.push({id: target.plan.item.id, eventId: target.plan.eventId, sheetSaved: true, error: error.message});}
  }
  try {
    if (requests.length) Sheets.Spreadsheets.batchUpdate({requests}, ss_().getId());
    saved.forEach(target => results.push({id: target.plan.item.id, eventId: target.plan.eventId, sheetSaved: true, needsCalendar: false, ...target.result}));
  } catch (_) {
    saved.forEach(target => results.push({id: target.plan.item.id, eventId: target.plan.eventId, sheetSaved: true,
      error: 'Calendar was saved, but its Events receipt was not confirmed. Retry safely to recover it.'}));
  }
  return results;
}

function qdpInboxValidateEvent_(fields, tz) {
  if (['Title (internal)','StartDate','EndDate','StartTime','EndTime'].some(key => !qviS_(fields[key]))) throw new Error('Title, start date/time and end date/time are required.');
  const dates = qdpScanDates_(fields, tz);
  if (!Number.isFinite(+dates.start) || !Number.isFinite(+dates.end) || dates.end <= dates.start) throw new Error('Use valid start and end dates/times, with end after start.');
  if (dates.end <= new Date()) throw new Error('Past event — not imported');
}

function qdpInboxDuplicateCalendar_(drafts) {
  if (!drafts.length) return [];
  const starts = drafts.map(draft => +draft.start), events = [];let pageToken;
  do {
    const page = Calendar.Events.list(CONFIG.CALENDAR_ID, {timeMin: new Date(Math.min(...starts) - 60000).toISOString(),
      timeMax: new Date(Math.max(...starts) + 60000).toISOString(), singleEvents: true, showDeleted: false, maxResults: 500,
      fields: 'nextPageToken,items(id,summary,start,location)', pageToken});
    events.push(...(page.items || []));pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

function qdpInboxImport_(items, phase) {
  if (!FLAGS.PUSH_ENABLED) throw new Error('Calendar writes are disabled.');
  phase = phase || 'complete';
  if (!['sheet','calendar','complete'].includes(phase)) throw new Error('Choose a valid import phase.');
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error('Import between one and twenty proposals.');
  const prepared = [], results = [];
  // Network downloads happen before the shared write lock. Revisions are checked inside it.
  for (const item of items) {
    if (!/^[a-f0-9]{64}$/.test(item.id || '') || !['event', 'correction'].includes(item.kind)) throw new Error('Invalid proposal.');
    try {
      if (item.kind === 'event') {
        qdpInboxValidateEvent_(item.fields, ss_().getSpreadsheetTimeZone());
        item.savedFlyer = '';
        if (phase !== 'calendar' && (item.fields.RawFlyerURL || item.fields.Flyer_URL)) {
          try {item.savedFlyer = qdpInboxFlyer_(item.id, item.fields).url;}
          catch (error) {item.flyerWarning = 'Added without a flyer: ' + error.message;}
        }
      } else if (phase !== 'sheet' && item.changes && item.changes.flyer) {
        item.savedFlyer = qdpInboxFlyer_(item.id, {'Title (internal)': item.eventId, RawFlyerURL: item.changes.flyer}).url;
      }
      prepared.push(item);
    } catch (error) { results.push({id: item.id, error: error.message}); }
  }
  if (!prepared.length) return {importVersion: 2, results};
  return qdpWithWriteLock_(() => {
    const table = qviEventTable_(true), c = table.col, lookups = buildLookupMaps_(), existing = {ids: new Set()}, tz = ss_().getSpreadsheetTimeZone();
    // Read only ID columns when checking uniqueness across historical tabs.
    if (phase !== 'calendar') ss_().getSheets().filter(sheet => sheet.getName() === CONFIG.SHEET_EVENTS || /archive/i.test(sheet.getName())).forEach(sheet => {
      if (sheet.getLastRow() < 2) return;
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], column = headers.indexOf('EventID') + 1;
      if (column) sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues().forEach(row => {if (row[0]) existing.ids.add(String(row[0]));});
    });
    const plans = [], append = [], sourceIndex = new Map();
    table.rows.forEach((row, i) => {
      const key = qviS_(qviRead_(row, c, 'sourceKey'));
      if (key) {if (!sourceIndex.has(key)) sourceIndex.set(key, []);sourceIndex.get(key).push({row, number: i + 2});}
    });
    const known = table.rows.map(row => qdpInboxEvent_(table, row, null, tz));
    const live = phase === 'calendar' ? [] : qdpInboxDuplicateCalendar_(prepared.filter(item => item.kind === 'event' && !sourceIndex.has('qdp-discovery:v1:' + item.id))
      .map(item => qdpScanDates_(item.fields, tz)));
    for (const item of prepared) {
      try {
        if (item.kind === 'correction') {
          results.push(phase === 'sheet' ? {id: item.id, prepared: true, needsCalendar: true} : {id: item.id, needsCalendar: false, ...qdpInboxCorrect_(item, table)});continue;
        }
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
        if (phase === 'calendar') throw new Error('The saved Events draft is missing. Save the selection to Events before creating Calendar entries.');
        const f = item.fields, detected = detectIdsByKeywords_([f['Title (internal)'], f.Description, f.Location, f.Lineup_Raw].filter(Boolean).join('\n'), lookups);
        const ids = qdpResolveEventIds_({venue: f.VenueID || '', artists: f['ArtistIDs (comma-separated)'] || '', colls: f['HostCollectiveIDs (comma-separated)'] || '', party: f.PartyID || ''},
          parseIdsFromDescription_(f.Description || ''), detected, lookups, {owned: [], pending: []});
        const draft = qviDraft_({title: f['Title (internal)'], startDate: f.StartDate, startTime: f.StartTime, endDate: f.EndDate, endTime: f.EndTime,
          timezone: f.Timezone || 'America/New_York', description: f.Description, venueId: ids.venue, artists: ids.artists, colls: ids.colls,
          party: ids.party, explicit: f['ExplicitQueer (Yes/No)'] || 'No', flyer: item.savedFlyer, url: f.Event_URL || f.Instagram_URL,
          location: f.Location, key, snapshot: JSON.stringify({discovery: item.discovery, fieldsRevision: qdpInboxFieldsRevision_(f)})}, tz);
        qviValidateIds_(draft, lookups);
        const same = known.filter(event => {
          return normalizeKey_(event.title) === normalizeKey_(draft.title) && event.fields.start.slice(0, 10) === draft.start.toISOString().slice(0, 10)
            && (draft.venueId ? event.venueId === draft.venueId : normalizeKey_(event.location) === normalizeKey_(draft.location));
        });
        if (same.length) {
          if (same.length > 1) throw new Error('Multiple existing listings match this discovery. Resolve them before importing.');
          const event = same[0];
          if (Math.abs(Date.parse(event.fields.start) - draft.start) >= 60000) throw new Error('An existing event has the same title, venue and date with a different time. Review it as a correction or confirm the distinct event manually.');
          results.push({id: item.id, eventId: event.eventId, alreadyPublished: event.publishToWeb && !!event.calendarId,
            calendarCreated: !!event.calendarId, error: event.publishToWeb && event.calendarId ? undefined : 'An existing QDP draft matches this discovery. Finish its existing Events record instead of adding another.'});
          continue;
        }
        // Catch Magic/Calendar additions that have not reached the Index yet.
        const duplicate = live.find(event => event.start && event.start.dateTime &&
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
        append.push(row);plans.push({item, eventId: id});sourceIndex.set(key, [{row}]);table.rows.push(row);known.push(qdpInboxEvent_(table, row, null, tz));
      } catch (error) {results.push({id: item.id, error: error.message});}
    }
    if (append.length) {
      Sheets.Spreadsheets.batchUpdate({requests: [{appendCells: {sheetId: table.sheet.getSheetId(),
        rows: append.map(row => ({values: row.map((value, i) => qdpInboxCell_(table.headers[i], value, tz))})),
        fields: 'userEnteredValue,userEnteredFormat.numberFormat'}}]}, ss_().getId());
    }
    if (phase === 'sheet') {
      plans.forEach(plan => results.push({id: plan.item.id, eventId: plan.eventId, sheetSaved: true, needsCalendar: true,
        ...(plan.item.flyerWarning ? {warning: plan.item.flyerWarning} : {})}));
    } else {
      const done = qdpInboxCalendarBatch_(qviEventTable_(false), plans, lookups);
      done.forEach(result => {const plan = plans.find(plan => plan.item.id === result.id);if (plan.item.flyerWarning) result.warning = plan.item.flyerWarning;});
      results.push(...done);
    }
    return {importVersion: 2, results};
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
  if (Object.keys(item.changes || {}).some(key => !Object.prototype.hasOwnProperty.call(QDP_APIFY_CORRECTION_LABELS_, key))) return qdpInboxCorrectFields_(item, table);
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
  try {
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
  } catch (error) {
    return {eventId: current.eventId, sheetSaved: true, correction: true, error: error.message};
  }
}

// Additional owner-selected fields use the same validators and derived values
// as the event editor. Existing five-field corrections retain their receipts.
function qdpInboxCorrectFields_(item, table) {
  if (typeof qdpArchiveAdminPrepareEvent_ !== 'function') throw new Error('Install ArchiveReview.gs v7.4.26 to edit other event fields.');
  const matches = table.rows.map((row, i) => ({row, number: i + 2})).filter(target =>
    qviS_(qviRead_(target.row, table.col, 'eventId')).toUpperCase() === String(item.eventId || '').toUpperCase());
  if (matches.length !== 1) throw new Error('The correction target is missing or duplicated in Events.');
  const target = {...matches[0], ss: ss_(), sheet: table.sheet,
    layout: qdpArchiveLayout_(table.sheet, table.headers), eventId: item.eventId};
  target.formulas = table.sheet.getRange(target.number, 1, 1, table.headers.length).getFormulas()[0];
  target.revision = qdpArchiveAdminEventRevision_(target);
  table.formulas = new Map([[target.row, target.formulas]]);
  const current = qdpInboxEvent_(table, target.row), keys = Object.keys(item.changes || {});
  const specs = qdpArchiveAdminEventFields_(target), byKey = new Map(specs.map(field => [qdpInboxFieldKey_(field), field]));
  if (!keys.length || keys.some(key => !byKey.has(key))) throw new Error('Select available event fields to apply.');
  const fingerprint = qdpAdminRevision_([item.eventId, item.changes]), receipts = qdpInboxReceipts_();
  const saved = receipts.rows.get(item.id);let receipt = saved && saved.value;
  if (receipt && receipt.fingerprint !== fingerprint) throw new Error('This correction already began with different selected values. Review its existing Events record before changing the proposal.');
  if (receipt?.phase === 'complete') return {eventId: current.eventId, sheetSaved: true, calendarCreated: true, correction: true, recovered: true};
  for (const key of keys) {
    const value = item.changes[key];
    if (typeof value !== 'string' || value.length > 50000 || byKey.get(key).readOnly) throw new Error('The selected event field cannot be edited: ' + key);
    const hash = qdpAdminRevision_([current.fields[key]]);
    if (receipt) {
      if (hash !== receipt.before[key] && hash !== receipt.desired[key]) throw new Error('Events ' + key + ' changed during the correction. Review before retrying.');
    } else if (!item.baseline || item.baseline.eventId !== current.eventId ||
      !Object.prototype.hasOwnProperty.call(item.baseline.fields || {}, key) || String(item.baseline.fields[key] || '') !== String(current.fields[key] || '')) {
      throw new Error('The listing changed since review. Load its current details before approving again.');
    }
  }
  const fields = {};
  for (const key of keys) {
    let value = item.changes[key];
    if (key === 'start' || key === 'end') {
      const prefix = key === 'start' ? 'Start' : 'End', local = qdpApifyCorrectionTime_(value);
      for (const suffix of ['Date','Time']) {
        const spec = specs.find(field => field.label === prefix + ' ' + suffix.toLowerCase());
        if (!spec || spec.readOnly) throw new Error('The selected event date/time cannot be edited.');
        fields[spec.key] = suffix === 'Date' ? local.slice(0,10) : local.slice(11);
      }
    } else {
      if (key === 'flyer') {
        if (!item.savedFlyer) throw new Error('Save and verify the selected source flyer first.');
        value = item.savedFlyer;
      }
      fields[byKey.get(key).key] = value;
    }
  }
  const plan = qdpArchiveAdminPrepareEvent_({expectedRevision: target.revision, fields}, target);
  const next = qdpInboxEvent_(table, plan.row);
  qdpApifyCorrectionCheckRange_(next.fields.start, next.fields.end);
  const receiptRow = saved ? saved.number : receipts.sheet.getLastRow() + 1;
  const put = () => receipts.sheet.getRange(receiptRow, 1, 1, 3).setValues([[item.id, JSON.stringify(receipt), nowISO()]]);
  let calendar;
  if (!receipt) {
    const lookups = buildLookupMaps_(), before = qdpInboxCorrectionCalendarBody_(table, target.row, lookups),
      after = qdpInboxCorrectionCalendarBody_(table, plan.row, lookups);
    const calendarDesired = {};
    for (const key of ['summary','location','description','start','end','colorId']) {
      if (qdpInboxCalendarValue_(before,key) !== qdpInboxCalendarValue_(after,key)) calendarDesired[key] = after[key] ?? (key === 'colorId' ? null : '');
    }
    const calendarId = eventIdForApi_(current.calendarId), calendarBefore = {};
    if (Object.keys(calendarDesired).length) {
      calendar = qdpApifyCorrectionReadCalendar_(calendarId);
      if (Object.prototype.hasOwnProperty.call(calendarDesired,'description')) {
        const main = stripAllQdpMetadata_(calendar.description || ''), footer = String(calendar.description || '').slice(main.length).trim();
        calendarDesired.description = [calendarDesired.description,footer].filter(Boolean).join('\n\n');
      }
      for (const key of Object.keys(calendarDesired)) {
        const live = qdpInboxCalendarValue_(calendar,key);
        if (!item.baseline.calendar || item.baseline.calendar.id !== calendarId || item.baseline.calendar.rawFields?.[key] !== live) {
          throw new Error('Calendar changed since review. Load its current details before approving again.');
        }
        calendarBefore[key] = qdpAdminRevision_([live]);
      }
    }
    receipt = {format: 2, fingerprint, eventId: current.eventId, phase: 'planned', calendarId,
      before: {}, desired: {}, calendarBefore, calendarDesired};
    keys.forEach(key => {
      receipt.before[key] = qdpAdminRevision_([current.fields[key]]);
      receipt.desired[key] = qdpAdminRevision_([next.fields[key]]);
    });
    put();
  }
  // Recheck the row after planning; never overwrite an intervening event edit.
  const fresh = table.sheet.getRange(target.number,1,1,table.headers.length);
  if (qdpArchiveAdminEventRevision_({...target,row:fresh.getValues()[0],formulas:fresh.getFormulas()[0]}) !== target.revision) throw new Error('The listing changed while saving. Reload and review it again.');
  if (plan.updates.size) qviSetRow_(table.sheet,target.number,plan.row,target.row);
  try {
    receipt.phase = 'sheet';put();
    const patch = {}, desired = receipt.calendarDesired || {};
    if (Object.keys(desired).length) {
      calendar = calendar || qdpApifyCorrectionReadCalendar_(receipt.calendarId);
      for (const [key,value] of Object.entries(desired)) {
        const live = qdpInboxCalendarValue_(calendar,key);
        if (live === qdpInboxCalendarValue_({[key]:value},key)) continue;
        if (qdpAdminRevision_([live]) !== receipt.calendarBefore[key]) throw new Error('Calendar ' + key + ' changed during this correction. Review before retrying.');
        patch[key] = value;
      }
      if (Object.keys(patch).length) Calendar.Events.patch(patch,CONFIG.CALENDAR_ID,receipt.calendarId,{sendUpdates:'none'},{'If-Match':calendar.etag});
    }
    receipt.phase = 'complete';put();
    return {eventId:current.eventId,sheetSaved:true,calendarCreated:true,correction:true};
  } catch (error) {
    return {eventId:current.eventId,sheetSaved:true,correction:true,error:error.message};
  }
}

function qdpInboxCorrectionCalendarBody_(table,row,lookups) {
  const read = key => qviRead_(row,table.col,key);
  const draft = qviDraft_({title:read('title'),startDate:read('startDate'),startTime:read('startTime'),
    endDate:read('endDate'),endTime:read('endTime'),timezone:read('timezone'),description:read('description'),
    venueId:read('venue'),artists:read('artists'),colls:read('colls'),party:read('party'),
    explicit:read('explicit'),flyer:read('flyer'),url:read('url'),location:read('location')},ss_().getSpreadsheetTimeZone());
  return qviCalendarBody_(draft,row,table.col,lookups,eventIdForApi_(read('calId')));
}
