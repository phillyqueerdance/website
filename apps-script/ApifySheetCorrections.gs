const QDP_APIFY_CORRECTION_TIME_ZONE_ = 'America/New_York';
const QDP_APIFY_CALENDAR_FIELDS_ = ['description', 'start', 'end'];

function qdpApifyCorrectionId_(id) {
  return String(id ?? '').trim().toUpperCase();
}

function qdpApifyCorrectionColumn_(table, name) {
  const key = qdpScanNormalize_(name);
  const matches = table.headers.map((header, index) => qdpScanNormalize_(header) === key ? index + 1 : 0).filter(Boolean);
  if (matches.length > 1) throw new Error(table.sheet.getName() + ' has more than one ' + name + ' column.');
  return matches[0] || 0;
}

function qdpApifyCorrectionValue_(table, row, name) {
  return row[qdpApifyCorrectionColumn_(table, name) - 1];
}

function qdpApifyCorrectionIntake_(ss) {
  const table = qdpPublicSheet_(qdpPublicReadContext_(ss), 'Apify Import');
  if (!table) return { entries: [] };
  const source = qdpApifyCorrectionColumn_(table, 'ImportSourceSnapshot');
  if (!source) return { table, entries: [] };
  const entries = [];
  table.rows.forEach((row, index) => {
    const text = row[source - 1];
    if (typeof text !== 'string' || !text.startsWith('{')) return;
    let snapshot;
    try { snapshot = JSON.parse(text); } catch { return; }
    if (snapshot?.kind !== 'correction') return;
    const eventId = qdpApifyCorrectionId_(snapshot.eventId);
    const rowEventId = qdpApifyCorrectionId_(qdpApifyCorrectionValue_(table, row, 'EventID'));
    if (!eventId || (eventId !== rowEventId && !snapshot.pendingPush)) return;
    entries.push({
      eventId, rowEventId, row, rowNumber: index + 2, snapshot,
      key: String(qdpApifyCorrectionValue_(table, row, 'ImportSourceKey') || '')
    });
  });
  return { table, entries };
}

function qdpApifyCorrectionPending_(entries) {
  const pending = new Map();
  for (const entry of entries) {
    if (!entry.snapshot.pendingPush) continue;
    if (!pending.has(entry.eventId)) pending.set(entry.eventId, []);
    pending.get(entry.eventId).push(entry);
  }
  return pending;
}

function qdpPendingApifyCorrectionFields_(ss) {
  const { entries } = qdpApifyCorrectionIntake_(ss);
  return new Map(Array.from(qdpApifyCorrectionPending_(entries), ([id, corrections]) =>
    [id, new Set(corrections.flatMap(entry => Object.keys(entry.snapshot.pendingPush.fields)))]
  ));
}

function qdpApifyCorrectionChanges_(table, entry, sheetTimeZone) {
  const changes = {};
  const approved = entry.snapshot.changes || {};
  for (const field of Object.keys(approved)) {
    if (!Object.prototype.hasOwnProperty.call(QDP_APIFY_CORRECTION_LABELS_, field)) {
      throw new Error('An approved correction field is unavailable.');
    }
    const read = name => {
      if (!qdpApifyCorrectionColumn_(table, name)) throw new Error('Apify Import is missing ' + name + '.');
      return qdpApifyCorrectionValue_(table, entry.row, name);
    };
    if (field === 'description') {
      changes.description = stripAllQdpMetadata_(String(read('Description') ?? ''));
    } else if (field === 'flyer') {
      changes.flyer = String(read('RawFlyerURL') || '').trim();
      if (!/^https:\/\/\S+$/i.test(changes.flyer)) throw new Error('The checked flyer needs a direct HTTPS image URL.');
    } else {
      const prefix = field === 'start' ? 'Start' : 'End';
      const date = qdpScanDateKey_(read(prefix + 'Date'), sheetTimeZone);
      const time = qdpScanClock_(read(prefix + 'Time'), sheetTimeZone);
      const local = qdpApifyCorrectionTime_(date + 'T' + time);
      changes[field] = Utilities.parseDate(local, QDP_APIFY_CORRECTION_TIME_ZONE_, "yyyy-MM-dd'T'HH:mm:ss").toISOString();
    }
  }
  if (!Object.keys(changes).length) throw new Error('The row has no approved correction fields.');
  return changes;
}

function qdpApifyCorrectionEventRow_(table, eventId) {
  const idColumn = qdpApifyCorrectionColumn_(table, 'EventID');
  if (!idColumn) throw new Error('Events needs an EventID column.');
  const matches = [];
  table.rows.forEach((row, index) => {
    if (qdpApifyCorrectionId_(row[idColumn - 1]) === eventId) matches.push({ row, rowNumber: index + 2 });
  });
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'The EventID appears more than once in Events.' : 'The EventID could not be found in Events.');
  }
  return matches[0];
}

function qdpApifyCorrectionCalendarId_(table, row) {
  const column = qdpApifyCorrectionColumn_(table, 'CalendarEventId');
  const id = column ? eventIdForApi_(row[column - 1]) : '';
  if (!id) throw new Error('The Events row needs a linked Google Calendar event.');
  if (table.rows.filter(item => eventIdForApi_(item[column - 1]) === id).length !== 1) {
    throw new Error('More than one Events row links to this Calendar event.');
  }
  return id;
}

function qdpApifyCorrectionReadCalendar_(id) {
  const event = Calendar.Events.get(CONFIG.CALENDAR_ID, id, {
    fields: 'id,etag,status,description,start,end,recurrence'
  });
  if (!event || event.status === 'cancelled' || eventIdForApi_(event.id) !== id ||
      !event.etag || !event.start || !event.end) {
    throw new Error('The linked Calendar event is unavailable.');
  }
  if (event.recurrence?.length) throw new Error('Link the specific Calendar occurrence before correcting a recurring event.');
  return event;
}

function qdpApifyCorrectionCalendarValue_(event, field) {
  if (field === 'description') return stripAllQdpMetadata_(event.description || '');
  const part = event[field];
  return part.dateTime ? new Date(part.dateTime).toISOString() : String(part.date || '');
}

function qdpApifyCorrectionSheetTime_(table, row, field, sheetTimeZone) {
  const prefix = field === 'start' ? 'Start' : 'End';
  const date = qdpApifyCorrectionValue_(table, row, prefix + 'Date');
  const time = qdpApifyCorrectionValue_(table, row, prefix + 'Time');
  if (date instanceof Date && time instanceof Date && +date === +time) return date.toISOString();
  const local = qdpScanDateKey_(date, sheetTimeZone) + ' ' + qdpScanClock_(time, sheetTimeZone);
  const format = 'yyyy-MM-dd HH:mm:ss';
  const instant = Utilities.parseDate(local, sheetTimeZone, format);
  if (Utilities.formatDate(instant, sheetTimeZone, format) !== local) throw new Error('Events has an invalid date or time.');
  return instant.toISOString();
}

function qdpApifyCorrectionCheckRange_(start, end) {
  if (!start.includes('T') || !end.includes('T')) {
    throw new Error('Choose both start and end to give an all-day event a time.');
  }
  if (!(new Date(end).getTime() > new Date(start).getTime())) {
    throw new Error('The resulting end must be after the start. Check the date for an overnight event.');
  }
}

function qdpApifyCorrectionTimedCell_(value, sheetTimeZone, isDate) {
  // Both Events columns store the full event timestamp, as in the regular Pull.
  const local = Utilities.formatDate(new Date(value), sheetTimeZone, "yyyy-MM-dd'T'HH:mm:ss");
  const numberValue = (new Date(local + 'Z').getTime() - Date.UTC(1899, 11, 30)) / 86400000;
  const numberFormat = isDate ? { type: 'DATE', pattern: 'MM/dd/yy' } : { type: 'TIME', pattern: 'hh:mm am/pm' };
  return { userEnteredValue: { numberValue }, userEnteredFormat: { numberFormat } };
}

function qdpApifyCorrectionCell_(table, rowNumber, name, value) {
  const column = qdpApifyCorrectionColumn_(table, name);
  if (!column) throw new Error(table.sheet.getName() + ' is missing ' + name + '.');
  const cell = typeof value === 'string' ? { userEnteredValue: { stringValue: value } } : value;
  if (cell.userEnteredValue.stringValue?.length > 50000) throw new Error(name + ' is too long for a Sheets cell.');
  return { updateCells: {
    start: { sheetId: table.sheet.getSheetId(), rowIndex: rowNumber - 1, columnIndex: column - 1 },
    rows: [{ values: [cell] }],
    fields: cell.userEnteredFormat ? 'userEnteredValue,userEnteredFormat.numberFormat' : 'userEnteredValue'
  } };
}

function qdpApifyCorrectionConfirmRows_(table, entries) {
  for (const entry of entries) {
    const current = table.sheet.getRange(entry.rowNumber, 1, 1, table.headers.length).getValues()[0];
    if (qdpAdminRevision_([current]) !== qdpAdminRevision_([entry.row])) {
      throw new Error(table.sheet.getName() + ' row ' + entry.rowNumber + ' changed during processing. Review it and try again.');
    }
  }
}

function qdpApifyCorrectionApplyEvent_(ss, intake, entries, previouslyPending) {
  const events = qdpPublicSheet_(qdpPublicReadContext_(ss), CONFIG.SHEET_EVENTS);
  if (!events) throw new Error('The Events tab is missing.');
  const eventId = entries[0].eventId;
  const target = qdpApifyCorrectionEventRow_(events, eventId);
  const sheetTimeZone = ss.getSpreadsheetTimeZone();
  const active = [];
  const approved = {};
  for (const entry of entries) {
    if (entry.rowEventId !== eventId) throw new Error('Restore the original EventID on Apify Import row ' + entry.rowNumber + '.');
    if (String(qdpApifyCorrectionValue_(intake, entry.row, 'Review') || '').trim().toLowerCase() !== 'correction') continue;
    const changes = qdpApifyCorrectionChanges_(intake, entry, sheetTimeZone);
    const applied = qdpAdminRevision_([changes]);
    // Retry a successfully applied row only after an edit or a reported Push conflict.
    if (entry.snapshot.applied === applied && !entry.snapshot.pendingPush?.needsReview) continue;
    for (const [field, value] of Object.entries(changes)) {
      if (field in approved && approved[field] !== value) {
        throw new Error('Select only one proposed value for ' + QDP_APIFY_CORRECTION_LABELS_[field] + '.');
      }
      approved[field] = value;
    }
    active.push({ entry, changes, applied });
  }
  if (!active.length) return { applied: 0, pending: 0 };

  const shared = QDP_APIFY_CALENDAR_FIELDS_.filter(field => field in approved);
  const pendingRows = new Map();
  let calendarId = '';
  if (shared.length) {
    calendarId = qdpApifyCorrectionCalendarId_(events, target.row);
    const event = qdpApifyCorrectionReadCalendar_(calendarId);
    if ('start' in approved || 'end' in approved) {
      qdpApifyCorrectionCheckRange_(
        approved.start || qdpApifyCorrectionSheetTime_(events, target.row, 'start', sheetTimeZone),
        approved.end || qdpApifyCorrectionSheetTime_(events, target.row, 'end', sheetTimeZone)
      );
    }
    for (const { entry, changes } of active) {
      const fields = {};
      for (const field of shared) {
        if (!(field in changes)) continue;
        const before = qdpApifyCorrectionCalendarValue_(event, field);
        if (changes[field] !== before) {
          fields[field] = { before: qdpAdminRevision_([before]), desired: qdpAdminRevision_([changes[field]]) };
        }
      }
      pendingRows.set(entry, Object.keys(fields).length ? { calendarId, fields } : null);
    }
  }

  const requests = [];
  if ('description' in approved) requests.push(qdpApifyCorrectionCell_(events, target.rowNumber, 'Description', approved.description));
  for (const field of ['start', 'end']) {
    if (!(field in approved)) continue;
    const prefix = field === 'start' ? 'Start' : 'End';
    for (const suffix of ['Date', 'Time']) {
      requests.push(qdpApifyCorrectionCell_(events, target.rowNumber, prefix + suffix,
        qdpApifyCorrectionTimedCell_(approved[field], sheetTimeZone, suffix === 'Date')));
    }
  }
  if ('flyer' in approved) {
    const previous = active.find(({ entry, changes }) => changes.flyer &&
      entry.snapshot.savedFlyer?.source === changes.flyer)?.entry.snapshot.savedFlyer;
    const title = String(qdpApifyCorrectionValue_(events, target.row, 'Title (internal)') || eventId);
    const file = previous || qdpScanSaveImage_(qdpScanFolder_(), approved.flyer, eventId + ' - ' + title);
    approved.savedFlyer = file.url;
    requests.push(qdpApifyCorrectionCell_(events, target.rowNumber, 'RawFlyerURL', approved.flyer));
    requests.push(qdpApifyCorrectionCell_(events, target.rowNumber, 'Flyer_URL', file.url));
  }

  const rowUpdates = new Map();
  for (const old of previouslyPending) {
    const fields = { ...old.snapshot.pendingPush.fields };
    if (!shared.some(field => field in fields)) continue;
    for (const field of shared) delete fields[field];
    const pendingPush = Object.keys(fields).length ? { calendarId: old.snapshot.pendingPush.calendarId, fields } : null;
    rowUpdates.set(old, {
      snapshot: { ...old.snapshot, pendingPush },
      status: pendingPush ? 'Applied to Events. Awaiting Push.' : 'Applied to Events. Later correction selected for Push.'
    });
  }
  for (const { entry, changes, applied } of active) {
    const pendingPush = pendingRows.get(entry) || null;
    const savedFlyer = changes.flyer ? { source: changes.flyer, url: approved.savedFlyer } : entry.snapshot.savedFlyer;
    const snapshot = { ...entry.snapshot, applied, pendingPush, savedFlyer };
    rowUpdates.set(entry, { snapshot, status: pendingPush ? 'Applied to Events. Awaiting Push.' : 'Applied to Events.' });
    if (changes.flyer) requests.push(qdpApifyCorrectionCell_(intake, entry.rowNumber, 'Saved_Flyer_URL', savedFlyer.url));
  }

  qdpApifyCorrectionConfirmRows_(events, [target]);
  qdpApifyCorrectionConfirmRows_(intake, Array.from(rowUpdates.keys()));
  for (const [entry, update] of rowUpdates) {
    requests.push(qdpApifyCorrectionCell_(intake, entry.rowNumber, 'ImportSourceSnapshot', JSON.stringify(update.snapshot)));
    requests.push(qdpApifyCorrectionCell_(intake, entry.rowNumber, 'Import_result', update.status));
  }
  Sheets.Spreadsheets.batchUpdate({ requests }, ss.getId());
  return { applied: active.length, pending: Array.from(pendingRows.values()).filter(Boolean).length };
}

function qdpApplySelectedApifyCorrections() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  if (sheet.getName() !== 'Apify Import') throw new Error('Select correction rows in Apify Import first.');
  const selected = new Set(qdpScanSelectedRows_(ss, sheet));
  const result = withSyncLock_(function() {
    const job = qdpAdminReadSyncJob_();
    if (job && ['queued', 'running'].includes(job.state)) throw new Error('Wait for the active Calendar sync to finish.');
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new Error('Another Index task is active. Try again.');
    try {
      const initial = qdpApifyCorrectionIntake_(ss);
      const groups = new Map();
      for (const entry of initial.entries) {
        if (!selected.has(entry.rowNumber) || !entry.key) continue;
        if (!groups.has(entry.eventId)) groups.set(entry.eventId, []);
        groups.get(entry.eventId).push(entry.key);
      }
      const result = { applied: 0, pending: 0, errors: [] };
      for (const [eventId, keys] of groups) {
        try {
          const { table, entries } = qdpApifyCorrectionIntake_(ss);
          const current = entries.filter(entry => entry.eventId === eventId && keys.includes(entry.key));
          if (current.length !== keys.length) throw new Error('The selected intake rows changed. Review your selection.');
          const previous = qdpApifyCorrectionPending_(entries).get(eventId) || [];
          const counts = qdpApifyCorrectionApplyEvent_(ss, table, current, previous);
          result.applied += counts.applied;
          result.pending += counts.pending;
        } catch (error) {
          result.errors.push(eventId + ' — ' + error.message);
        }
      }
      return result;
    } finally {
      lock.releaseLock();
    }
  });
  const lines = [result.applied + ' correction rows applied to Events.'];
  if (result.pending) lines.push(result.pending + ' rows awaiting Push.');
  SpreadsheetApp.getUi().alert(lines.concat(result.errors).join('\n'));
}

function qdpApifyCorrectionPushStatus_(ss, intake, entries, status, needsReview) {
  qdpApifyCorrectionConfirmRows_(intake, entries);
  const requests = [];
  for (const entry of entries) {
    const pendingPush = status === 'Pushed to Calendar.' ? null :
      { ...entry.snapshot.pendingPush, needsReview };
    requests.push(qdpApifyCorrectionCell_(intake, entry.rowNumber, 'ImportSourceSnapshot',
      JSON.stringify({ ...entry.snapshot, pendingPush })));
    requests.push(qdpApifyCorrectionCell_(intake, entry.rowNumber, 'Import_result', status));
  }
  Sheets.Spreadsheets.batchUpdate({ requests }, ss.getId());
}

function qdpPushApifyCorrections_(ss, events) {
  const { table, entries } = qdpApifyCorrectionIntake_(ss);
  const pending = qdpApifyCorrectionPending_(entries);
  const calendarIds = new Set(entries.map(entry => entry.snapshot.pendingPush?.calendarId).filter(Boolean));
  const result = { eventIds: new Set(pending.keys()), calendarIds, patched: 0, acknowledged: 0, failures: [] };
  for (const [eventId, approvals] of pending) {
    try {
      const mismatched = approvals.find(entry => entry.rowEventId !== eventId);
      if (mismatched) throw new Error('Restore the original EventID on Apify Import row ' + mismatched.rowNumber + '.');
      const { row } = qdpApifyCorrectionEventRow_(events, eventId);
      const id = qdpApifyCorrectionCalendarId_(events, row);
      const calendar = qdpApifyCorrectionReadCalendar_(id);
      const timeZone = ss.getSpreadsheetTimeZone();
      const patch = {};
      for (const entry of approvals) {
        const saved = entry.snapshot.pendingPush;
        if (saved.calendarId !== id) throw new Error('The linked Calendar event changed since Apply.');
        for (const [field, approved] of Object.entries(saved.fields)) {
          if (!QDP_APIFY_CALENDAR_FIELDS_.includes(field)) throw new Error('An approved Calendar field is unavailable.');
          const value = field === 'description'
            ? stripAllQdpMetadata_(String(qdpApifyCorrectionValue_(events, row, 'Description') ?? ''))
            : qdpApifyCorrectionSheetTime_(events, row, field, timeZone);
          if (qdpAdminRevision_([value]) !== approved.desired) throw new Error('Events ' + field + ' changed since Apply.');
          const live = qdpApifyCorrectionCalendarValue_(calendar, field);
          if (live === value) continue;
          if (qdpAdminRevision_([live]) !== approved.before) throw new Error('Calendar ' + field + ' changed since Apply.');
          if (field === 'description') {
            const footer = String(calendar.description || '').slice(live.length).trim();
            patch.description = [value, footer].filter(Boolean).join('\n\n');
          } else {
            patch[field] = { dateTime: value, timeZone: calendar[field].timeZone || QDP_APIFY_CORRECTION_TIME_ZONE_ };
          }
        }
      }
      if (patch.start || patch.end) {
        qdpApifyCorrectionCheckRange_(
          patch.start?.dateTime || qdpApifyCorrectionCalendarValue_(calendar, 'start'),
          patch.end?.dateTime || qdpApifyCorrectionCalendarValue_(calendar, 'end')
        );
      }

      if (Object.keys(patch).length) {
        const target = qdpApifyCorrectionEventRow_(events, eventId);
        qdpApifyCorrectionConfirmRows_(events, [target]);
        qdpApifyCorrectionConfirmRows_(table, approvals);
        Calendar.Events.patch(patch, CONFIG.CALENDAR_ID, id, { sendUpdates: 'none' }, { 'If-Match': calendar.etag });
        result.patched++;
      }
      qdpApifyCorrectionPushStatus_(ss, table, approvals, 'Pushed to Calendar.');
      result.acknowledged++;
    } catch (error) {
      const detail = String(error.message || error);
      result.failures.push(eventId + ' — ' + detail);
      Logger.log(eventId + ' — correction Push: ' + detail);
      const needsReview = /changed since Apply|condition failed|\b412\b|resulting end|all-day|original EventID/i.test(detail);
      const status = (needsReview ? 'Push needs review. ' : 'Awaiting Push. ') + detail;
      try {
        qdpApifyCorrectionPushStatus_(ss, table, approvals, status, needsReview);
      } catch (statusError) {
        Logger.log(eventId + ' — correction status could not be saved. ' + statusError.message);
      }
    }
  }
  return result;
}

