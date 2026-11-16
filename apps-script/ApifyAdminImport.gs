/*
 * In Core.gs, inside qdpAdminHandlePost_ after its token check and action
 * normalization, add:
 * if (action === 'admin.apifyimport') return { ok: 'yes', ...qdpAdminApifyImport_(body.rows) };
 *
 * Uses the existing scraper.gs header map and Google Sheets advanced service.
 */
function qdpAdminApifyImport_(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Choose at least one event to include.');
  }
  if (typeof Sheets === 'undefined') {
    throw new Error('Enable the Google Sheets API in Apps Script Services.');
  }
  if (typeof qdpScanMap_ !== 'function' || typeof qdpScanInputs_ !== 'function') {
    throw new Error('Install the Index Apify importer script first.');
  }

  const editable = qdpScanInputs_().concat(['Instagram_URL', 'Review_notes']);
  const candidates = rows.map(row => {
    if (!row || typeof row.key !== 'string' || !/^[a-f0-9]{64}:[1-9]\d{0,6}$/.test(row.key)
        || !row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) {
      throw new Error('An included row is invalid. Reopen the source workbook and try again.');
    }
    const data = {};
    for (const name of editable) {
      const value = row.fields[name] ?? '';
      if (typeof value !== 'string' || value.length > 50000) {
        throw new Error('Review the ' + name + ' value on workbook row ' + row.key.split(':')[1] + '.');
      }
      data[name] = value;
    }
    data.Review = 'Include';
    data.ImportSourceKey = 'admin-apify:' + row.key;
    return data;
  });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another Index task is active. Try saving again.');
  try {
    const ss = ss_();
    const sheet = ss.getSheetByName('Apify Import');
    if (!sheet) throw new Error('The Index is missing its Apify Import tab. Run qdpSetupApifyImport first.');
    const columns = qdpScanMap_(sheet, editable.concat(['Review', 'Import readiness', 'ImportSourceKey']));
    const width = Math.max(...Object.values(columns));
    const lastRow = sheet.getLastRow();
    const existingKeys = lastRow > 1
      ? sheet.getRange(2, columns.ImportSourceKey, lastRow - 1, 1).getValues().flat()
      : [];
    const seen = new Set(existingKeys);
    const append = [];
    const timezone = ss.getSpreadsheetTimeZone();

    for (const data of candidates) {
      if (seen.has(data.ImportSourceKey)) continue;
      seen.add(data.ImportSourceKey);
      try {
        data['Import readiness'] = qdpScanValidate_(data, timezone).reason;
      } catch {
        data['Import readiness'] = 'Check event dates and times';
      }
      const values = Array.from({ length: width }, () => ({}));
      for (const [name, value] of Object.entries(data)) {
        if (value) values[columns[name] - 1] = qdpAdminApifyCell_(name, value, timezone);
      }
      append.push({ values });
    }

    if (append.length) {
      Sheets.Spreadsheets.batchUpdate({
        requests: [{
          appendCells: {
            sheetId: sheet.getSheetId(),
            rows: append,
            fields: 'userEnteredValue,userEnteredFormat.numberFormat'
          }
        }]
      }, ss.getId());
    }
    return { added: append.length, alreadySaved: candidates.length - append.length };
  } finally {
    lock.releaseLock();
  }
}

function qdpAdminApifyCell_(name, value, timezone) {
  // Keep other fields literal and leave invalid date or time text visible for review.
  const literal = { userEnteredValue: { stringValue: value } };
  const isDate = name === 'StartDate' || name === 'EndDate';
  const isTime = name === 'StartTime' || name === 'EndTime';
  if (!isDate && !isTime) return literal;

  let numberValue;
  let numberFormat;
  try {
    if (isDate) {
      const key = qdpScanDateKey_(value, timezone);
      const midnight = new Date(key + 'T00:00:00Z');
      if (isNaN(midnight) || midnight.toISOString().slice(0, 10) !== key) return literal;
      numberValue = (midnight.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
      numberFormat = { type: 'DATE', pattern: 'MM/dd/yy' };
    } else {
      const [hours, minutes, seconds] = qdpScanClock_(value, timezone).split(':').map(Number);
      numberValue = (hours * 3600 + minutes * 60 + seconds) / 86400;
      numberFormat = { type: 'TIME', pattern: 'hh:mm am/pm' };
    }
  } catch {
    return literal;
  }
  return { userEnteredValue: { numberValue }, userEnteredFormat: { numberFormat } };
}
