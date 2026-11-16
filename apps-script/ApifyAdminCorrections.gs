const QDP_APIFY_CORRECTION_LABELS_ = Object.freeze({
  description: 'Description',
  start: 'Start date and time',
  end: 'End date and time',
  flyer: 'Flyer'
});

function qdpApifyCorrectionTime_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    throw new Error('Enter a date and time for each checked schedule field.');
  }
  const local = value.length === 16 ? value + ':00' : value;
  const timeZone = 'America/New_York';
  const format = "yyyy-MM-dd'T'HH:mm:ss";
  const date = Utilities.parseDate(local, timeZone, format);
  if (Utilities.formatDate(date, timeZone, format) !== local) {
    throw new Error('That date or time is invalid in Philadelphia.');
  }
  return local;
}

function qdpApifyCorrectionStage_(body) {
  if (typeof Sheets === 'undefined') {
    throw new Error('Enable the Google Sheets API in Apps Script Services.');
  }
  if (typeof qdpScanMap_ !== 'function' || typeof qdpAdminApifyCell_ !== 'function') {
    throw new Error('Install the current Apify import scripts first.');
  }
  if (typeof body.key !== 'string' || !/^[a-f0-9]{64}:[1-9]\d{0,6}$/.test(body.key)) {
    throw new Error('Reopen the scrape workbook before saving this correction.');
  }
  const eventId = typeof body.eventId === 'string' ? body.eventId.trim().toUpperCase() : '';
  if (!eventId || eventId.length > 128 || /\s/.test(eventId)) {
    throw new Error('A valid QDP EventID is required.');
  }
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 50000) {
    throw new Error('The correction needs the existing event’s title.');
  }
  const changes = body.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    throw new Error('Check the correction fields you want to save.');
  }
  for (const field of Object.keys(changes)) {
    if (!Object.prototype.hasOwnProperty.call(QDP_APIFY_CORRECTION_LABELS_, field)) {
      throw new Error('That correction field is unavailable.');
    }
  }

  const approved = {};
  const cells = { EventID: eventId, 'Title (internal)': body.title, Review: 'Correction', 'Import readiness': 'Staged correction' };
  for (const field of Object.keys(QDP_APIFY_CORRECTION_LABELS_)) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    const value = changes[field];
    if (field === 'start' || field === 'end') {
      const local = qdpApifyCorrectionTime_(value);
      const prefix = field === 'start' ? 'Start' : 'End';
      cells[prefix + 'Date'] = local.slice(0, 10);
      cells[prefix + 'Time'] = local.slice(11);
      cells.Timezone = 'America/New_York';
      approved[field] = local;
    } else {
      if (typeof value !== 'string' || value.length > 50000) {
        throw new Error('Enter a valid ' + QDP_APIFY_CORRECTION_LABELS_[field].toLowerCase() + '.');
      }
      if (field === 'flyer' && !/^https:\/\/\S+$/i.test(value)) {
        throw new Error('The flyer needs a direct HTTPS image URL.');
      }
      cells[field === 'description' ? 'Description' : 'RawFlyerURL'] = value;
      approved[field] = value;
    }
  }
  if (approved.start && approved.end && approved.end <= approved.start) {
    throw new Error('End must be after start. For an overnight event, check the end date.');
  }

  if (typeof body.listingUrl === 'string' && /^https:\/\/\S+$/i.test(body.listingUrl)) cells.Event_URL = body.listingUrl;
  if (typeof body.sourceUrl === 'string' && /^https:\/\/\S+$/i.test(body.sourceUrl)) cells.Instagram_URL = body.sourceUrl;
  cells.Review_notes = 'Approved correction fields are ' +
    Object.keys(approved).map(field => QDP_APIFY_CORRECTION_LABELS_[field]).join(', ') + '.';
  cells.ImportSourceSnapshot = JSON.stringify({ kind: 'correction', eventId, changes: approved, timeZone: cells.Timezone });
  if (Object.values(cells).some(value => value.length > 50000)) throw new Error('The correction is too long for a Sheets cell.');
  // Retrying the same approval, including after a lost response, reuses its key.
  cells.ImportSourceKey = 'admin-apify-correction:' + qdpAdminRevision_([body.key, eventId, approved]);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another Index task is active. Try saving again.');
  try {
    const ss = ss_();
    const intake = ss.getSheetByName('Apify Import');
    if (!intake) throw new Error('The Index is missing its Apify Import tab.');
    const columns = qdpScanMap_(intake, Object.keys(cells));
    const lastRow = intake.getLastRow();
    if (lastRow > 1) {
      const keys = intake.getRange(2, columns.ImportSourceKey, lastRow - 1, 1).getValues().flat();
      if (keys.includes(cells.ImportSourceKey)) return { alreadySaved: true };
    }

    const values = Array.from({ length: Math.max(...Object.values(columns)) }, () => ({}));
    const timezone = ss.getSpreadsheetTimeZone();
    for (const [name, value] of Object.entries(cells)) {
      values[columns[name] - 1] = qdpAdminApifyCell_(name, value, timezone);
    }
    Sheets.Spreadsheets.batchUpdate({
      requests: [{
        appendCells: {
          sheetId: intake.getSheetId(),
          rows: [{ values }],
          fields: 'userEnteredValue,userEnteredFormat.numberFormat'
        }
      }]
    }, ss.getId());
    return { alreadySaved: false };
  } finally {
    lock.releaseLock();
  }
}
