const QDP_APIFY_CORRECTION_PREFIX_ = 'QDP_APIFY_CORRECTION_PENDING:';
const QDP_APIFY_CORRECTION_SHARED_ = ['description', 'start', 'end'];
const QDP_APIFY_CORRECTION_FIELDS_ = [...QDP_APIFY_CORRECTION_SHARED_, 'flyer'];

function qdpApifyCorrectionPendingIds_() {
  const keys = PropertiesService.getScriptProperties().getKeys();
  return new Set(keys.filter(key => key.startsWith(QDP_APIFY_CORRECTION_PREFIX_))
    .map(key => key.slice(QDP_APIFY_CORRECTION_PREFIX_.length)));
}

function qdpApifyCorrectionContext_(id) {
  const eventId = String(id || '').trim().toUpperCase();
  if (!eventId) throw new Error('The correction needs a QDP EventID.');
  const reads = qdpPublicReadContext_();
  const data = qdpPublicSheet_(reads, CONFIG.SHEET_EVENTS);
  if (!data) throw new Error('Events tab not found.');
  const headers = data.headers;
  const idColumn = qdpAdminColumn_(headers, ['EventID', 'Event ID'], 'EventID');
  const calendarColumn = qdpAdminColumn_(headers, ['CalendarEventId', 'Calendar Event Id']);
  const titleColumn = qdpAdminColumn_(headers, ['Title (internal)'], 'Title (internal)');
  const timeZoneColumn = qdpAdminColumn_(headers, ['Timezone', 'Time zone']);
  const columns = {
    description: [qdpAdminColumn_(headers, ['Description'])],
    start: [qdpAdminColumn_(headers, ['StartDate', 'Start Date']), qdpAdminColumn_(headers, ['StartTime', 'Start Time'])],
    end: [qdpAdminColumn_(headers, ['EndDate', 'End Date']), qdpAdminColumn_(headers, ['EndTime', 'End Time'])],
    flyer: [qdpAdminColumn_(headers, ['Flyer_URL', 'Flyer URL', 'FlyerURL']), qdpAdminColumn_(headers, ['RawFlyerURL', 'Raw Flyer URL'])]
  };
  const matches = [];
  data.rows.forEach((row, index) => {
    if (trim(row[idColumn - 1]).toUpperCase() === eventId) matches.push({ row, rowIndex: index + 1 });
  });
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'More than one Events row has this EventID.' : 'This event is no longer in the active Events tab.');
  }

  const { row, rowIndex } = matches[0];
  const calendarId = eventIdForApi_(calendarColumn ? row[calendarColumn - 1] : '');
  const sheetTimeZone = reads.ss.getSpreadsheetTimeZone();
  const timeZone = trim(timeZoneColumn ? row[timeZoneColumn - 1] : '') || Session.getScriptTimeZone() || 'America/New_York';
  const sheetRaw = {};
  for (const field of QDP_APIFY_CORRECTION_FIELDS_) {
    sheetRaw[field] = columns[field].map(column => column ? row[column - 1] : '');
  }
  const sheet = {
    description: String(sheetRaw.description[0] || ''),
    start: qdpApifyCorrectionSheetTime_(sheetRaw.start, sheetTimeZone, timeZone),
    end: qdpApifyCorrectionSheetTime_(sheetRaw.end, sheetTimeZone, timeZone),
    flyer: String(sheetRaw.flyer[0] || '')
  };

  let calendar = null;
  let calendarMessage = 'This Events row has no linked Calendar event.';
  if (calendarId) {
    const duplicate = data.rows.filter(event => eventIdForApi_(event[calendarColumn - 1]) === calendarId).length > 1;
    if (duplicate) {
      calendarMessage = 'This Calendar event is linked to multiple Events rows.';
    } else {
      try {
        const event = Calendar.Events.get(CONFIG.CALENDAR_ID, calendarId, {
          fields: 'id,etag,status,description,start,end,recurrence'
        });
        if (event?.status === 'cancelled') calendarMessage = 'The linked Calendar event is cancelled.';
        else if (event?.recurrence?.length) calendarMessage = 'This row links to a repeating series. Use an individual occurrence to change its listing.';
        else if (event?.etag && event.start && event.end && eventIdForApi_(event.id) === calendarId) {
          calendar = event;
          calendarMessage = '';
        } else {
          calendarMessage = 'The linked Calendar event could not be verified.';
        }
      } catch (error) {
        calendarMessage = 'The linked Calendar event could not be loaded. Try again.';
      }
    }
  }
  const cal = calendar ? {
    description: stripAllQdpMetadata_(calendar.description || ''),
    start: calendar.start.dateTime ? qdpApifyCorrectionInstant_(calendar.start.dateTime) : String(calendar.start.date || ''),
    end: calendar.end.dateTime ? qdpApifyCorrectionInstant_(calendar.end.dateTime) : String(calendar.end.date || '')
  } : null;

  const sheetRevisions = {};
  const revisions = {};
  for (const field of QDP_APIFY_CORRECTION_FIELDS_) {
    sheetRevisions[field] = qdpAdminRevision_([eventId, calendarId, field, sheetRaw[field]]);
    const calendarValue = field === 'description' ? calendar?.description || '' : cal?.[field] || '';
    revisions[field] = qdpAdminRevision_([sheetRevisions[field], calendarValue]);
  }

  const properties = PropertiesService.getScriptProperties();
  const pendingKey = calendarId ? QDP_APIFY_CORRECTION_PREFIX_ + calendarId : '';
  const pendingText = pendingKey ? properties.getProperty(pendingKey) : '';
  return {
    eventId, title: String(row[titleColumn - 1] || ''),
    calendarId, calendar, calendarMessage, cal, sheet, sheetRaw, timeZone, sheetTimeZone,
    columnMap: columns, sheetRevisions, revisions, rowIndex,
    sheetId: data.sheet.getSheetId(), spreadsheetId: reads.ss.getId(),
    properties, pendingKey, pending: pendingText ? JSON.parse(pendingText) : null
  };
}

function qdpApifyCorrectionInstant_(value) {
  const date = new Date(value || '');
  return isNaN(date.getTime()) ? '' : date.toISOString();
}

function qdpApifyCorrectionSheetTime_(raw, sheetTimeZone, eventTimeZone) {
  const [date, time] = raw;
  if (date === '' || date == null || time === '' || time == null) {
    return qdpApifyCorrectionInstant_(qdpPublicDateTime_(date, time, eventTimeZone));
  }
  try {
    const day = qdpScanDateKey_(date, sheetTimeZone);
    const clock = qdpScanClock_(time, sheetTimeZone);
    return Utilities.parseDate(day + ' ' + clock, sheetTimeZone, 'yyyy-MM-dd HH:mm:ss').toISOString();
  } catch {
    return qdpApifyCorrectionInstant_(qdpPublicDateTime_(date, time, eventTimeZone));
  }
}

function qdpApifyCorrectionLocal_(value) {
  if (!value || !value.includes('T')) return value || '';
  return Utilities.formatDate(new Date(value), 'America/New_York', "yyyy-MM-dd'T'HH:mm:ss");
}

function qdpApifyCorrectionView_(context) {
  return {
    eventId: context.eventId,
    index: context.sheet,
    calendar: context.cal,
    calendarMessage: context.calendarMessage,
    localTime: {
      start: qdpApifyCorrectionLocal_(context.cal?.start || context.sheet.start),
      end: qdpApifyCorrectionLocal_(context.cal?.end || context.sheet.end)
    },
    revisions: context.revisions,
    available: {
      description: Boolean(context.calendar && context.columnMap.description[0]),
      start: Boolean(context.calendar && context.columnMap.start.every(Boolean)),
      end: Boolean(context.calendar && context.columnMap.end.every(Boolean)),
      flyer: Boolean(context.columnMap.flyer[0])
    },
    pendingFields: context.pending?.fields || []
  };
}

function qdpApifyCorrectionReview_(body) {
  return qdpApifyCorrectionView_(qdpApifyCorrectionContext_(body.eventId));
}

function qdpApifyCorrectionDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    throw new Error('Choose a date and time for the checked schedule field.');
  }
  const local = value.length === 16 ? value + ':00' : value;
  const timeZone = 'America/New_York';
  const format = "yyyy-MM-dd'T'HH:mm:ss";
  const instant = Utilities.parseDate(local, timeZone, format);
  if (Utilities.formatDate(instant, timeZone, format) !== local) {
    throw new Error('That date or time is invalid in Philadelphia.');
  }
  return instant.toISOString();
}

function qdpApifyCorrectionPlan_(context, changes, revisions, savedFlyer) {
  const view = qdpApifyCorrectionView_(context);
  const values = {};
  const patch = {};
  for (const field of Object.keys(changes)) {
    if (!QDP_APIFY_CORRECTION_FIELDS_.includes(field) || !view.available[field]) {
      throw new Error('That field is unavailable. ' + context.calendarMessage);
    }
    if (typeof revisions?.[field] !== 'string' || revisions[field] !== context.revisions[field]) {
      throw new Error('The ' + field + ' changed since you reviewed it. Review the latest values and try again.');
    }
    const value = changes[field];
    if (field === 'flyer') {
      if (typeof value !== 'string' || !/^https:\/\/\S+$/i.test(value)) {
        throw new Error('The suggested flyer needs a direct image URL.');
      }
      if (savedFlyer) values.flyer = savedFlyer;
    } else if (field === 'description') {
      if (typeof value !== 'string' || value.length > 20000) throw new Error('Enter a valid description under 20,000 characters.');
      values.description = stripAllQdpMetadata_(value.replace(/\r\n?/g, '\n').trim());
      if (values.description !== context.cal.description) {
        const old = context.calendar.description || '';
        const footer = old.slice(context.cal.description.length).trim();
        // Keep any legacy QDP flyer/ID footer associated with the event.
        patch.description = footer ? [values.description, footer].filter(Boolean).join('\n\n') : values.description;
      }
    } else {
      values[field] = qdpApifyCorrectionDate_(value);
      if (values[field] !== context.cal[field]) {
        patch[field] = { dateTime: values[field], timeZone: context.calendar[field].timeZone || 'America/New_York' };
      }
    }
  }
  if ('start' in values || 'end' in values) {
    const start = values.start || context.cal.start;
    const end = values.end || context.cal.end;
    if (!start.includes('T') || !end.includes('T')) {
      throw new Error('Choose both start and end to give this all-day event a time.');
    }
    if (!(new Date(end).getTime() > new Date(start).getTime())) throw new Error('End must be after start. For an overnight event, check the end date.');
  }
  return { values, patch };
}

function qdpApifyCorrectionWriteSheet_(context, values) {
  const requests = [];
  function cell(column, value, numberFormat) {
    if (!column) throw new Error('An Events column required for this correction is missing.');
    const userEnteredValue = numberFormat ? { numberValue: value } : { stringValue: value };
    const target = { userEnteredValue };
    if (numberFormat) target.userEnteredFormat = { numberFormat };
    requests.push({ updateCells: {
      start: { sheetId: context.sheetId, rowIndex: context.rowIndex, columnIndex: column - 1 },
      rows: [{ values: [target] }],
      fields: numberFormat ? 'userEnteredValue,userEnteredFormat.numberFormat' : 'userEnteredValue'
    } });
  }
  for (const [field, value] of Object.entries(values)) {
    const columns = context.columnMap[field];
    if (field === 'flyer') {
      if (context.sheet.flyer !== value.url) cell(columns[0], value.url);
      if (columns[1] && context.sheetRaw.flyer[1] !== value.source) cell(columns[1], value.source);
    } else if (field === 'description') {
      if (context.sheet.description !== value) cell(columns[0], value);
    } else if (context.sheet[field] !== value ||
               context.sheetRaw[field].some(item => !(item instanceof Date) || item.toISOString() !== value)) {
      // Core stores the same complete timestamp in both date and time columns.
      const local = Utilities.formatDate(new Date(value), context.sheetTimeZone, "yyyy-MM-dd'T'HH:mm:ss");
      const serial = (new Date(local + 'Z').getTime() - Date.UTC(1899, 11, 30)) / 86400000;
      cell(columns[0], serial, { type: 'DATE', pattern: 'MM/dd/yy' });
      cell(columns[1], serial, { type: 'TIME', pattern: 'hh:mm am/pm' });
    }
  }
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests }, context.spreadsheetId);
}

function qdpApifyCorrectionMatchesSheet_(context, field, value) {
  if (field === 'flyer') {
    return context.sheet.flyer === value.url &&
      (!context.columnMap.flyer[1] || context.sheetRaw.flyer[1] === value.source);
  }
  if (field === 'description') return context.sheet.description === value;
  return context.sheetRaw[field].every(item => item instanceof Date && item.toISOString() === value);
}

function qdpApifyCorrectionComplete_(context) {
  const pending = context.pending;
  if (!pending) return { message: 'There is no unfinished correction.', review: qdpApifyCorrectionView_(context) };
  if (context.eventId !== pending.eventId || !context.cal) {
    throw new Error('The pending correction still needs its original Events row and Calendar event. ' + context.calendarMessage);
  }
  const shared = pending.fields.filter(field => field !== 'flyer');
  const tableChanged = pending.fields.some(field => context.sheetRevisions[field] !== pending.sheetRevisions[field]);
  const applied = shared.every(field => qdpAdminRevision_([context.cal[field]]) === pending.wanted[field]);
  if (!applied) {
    if ((!tableChanged && shared.every(field => qdpAdminRevision_([context.cal[field]]) === pending.before[field])) ||
        shared.every(field => context.sheet[field] === context.cal[field])) {
      context.properties.deleteProperty(context.pendingKey);
      context.pending = null;
      return { message: 'The earlier attempt did not finish these corrections. Review the current values before applying again.', review: qdpApifyCorrectionView_(context) };
    }
    throw new Error('Calendar changed again before the Index was updated. Compare the selected fields and resolve the difference before finishing.');
  }

  const values = {};
  let keptNewerFlyer = false;
  for (const field of pending.fields) {
    const value = field === 'flyer' ? pending.flyer : context.cal[field];
    if (context.sheetRevisions[field] !== pending.sheetRevisions[field] &&
        !qdpApifyCorrectionMatchesSheet_(context, field, value)) {
      if (field === 'flyer') {
        keptNewerFlyer = true;
        continue;
      }
      throw new Error('The ' + field + ' changed in the Index after approval. Compare it with Calendar and align that field in the two systems before finishing.');
    }
    values[field] = value;
  }
  qdpApifyCorrectionWriteSheet_(context, values);
  context.properties.deleteProperty(context.pendingKey);
  return {
    message: keptNewerFlyer ? 'Calendar and Index synced. The Index flyer was edited after approval and has been kept.'
      : 'Selected changes applied.',
    review: qdpApifyCorrectionView_(qdpApifyCorrectionContext_(context.eventId))
  };
}

function qdpApifyCorrectionWithLock_(work) {
  return withSyncLock_(function() {
    const job = qdpAdminReadSyncJob_();
    if (job && ['queued', 'running'].includes(job.state)) throw new Error('Wait for the current Calendar sync to finish.');
    if (typeof Sheets === 'undefined') throw new Error('The Google Sheets API must be enabled in Apps Script Services.');
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new Error('Another Index operation is active. Try again.');
    try {
      return work();
    } finally {
      lock.releaseLock();
    }
  });
}

function qdpApifyCorrectionApply_(body) {
  const changes = body.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    throw new Error('Check the changes you want to apply.');
  }
  return qdpApifyCorrectionWithLock_(function() {
    let context = qdpApifyCorrectionContext_(body.eventId);
    if (context.pending) throw new Error('Finish the previous correction for this event before applying another.');
    let plan = qdpApifyCorrectionPlan_(context, changes, body.revisions);
    if (!FLAGS.PUSH_ENABLED && Object.keys(plan.patch).length) throw new Error('Calendar writes are disabled in Apps Script.');
    if ('flyer' in changes) {
      const source = changes.flyer;
      const file = qdpScanSaveImage_(qdpScanFolder_(), source, context.eventId + ' - ' + context.title);
      context = qdpApifyCorrectionContext_(body.eventId);
      plan = qdpApifyCorrectionPlan_(context, changes, body.revisions, { url: file.url, source });
    }

    if (!Object.keys(plan.patch).length) {
      qdpApifyCorrectionWriteSheet_(context, plan.values);
      return { message: 'Selected changes applied.', review: qdpApifyCorrectionView_(qdpApifyCorrectionContext_(body.eventId)) };
    }

    const fields = Object.keys(plan.values);
    const shared = fields.filter(field => field !== 'flyer');
    const pending = {
      eventId: context.eventId,
      fields,
      sheetRevisions: Object.fromEntries(fields.map(field => [field, context.sheetRevisions[field]])),
      before: Object.fromEntries(shared.map(field => [field, qdpAdminRevision_([context.cal[field]])])),
      wanted: Object.fromEntries(shared.map(field => [field, qdpAdminRevision_([plan.values[field]])])),
      flyer: plan.values.flyer || null
    };
    // Record the confirmed selection before a Calendar write. Normal sync skips
    // this event until the matching Index write is confirmed or safely abandoned.
    context.properties.setProperty(context.pendingKey, JSON.stringify(pending));
    try {
      Calendar.Events.patch(plan.patch, CONFIG.CALENDAR_ID, context.calendarId,
        { sendUpdates: 'none' }, { 'If-Match': context.calendar.etag });
    } catch (error) {
      // An explicit precondition failure guarantees that this patch was refused.
      if (/precondition failed|\b412\b/i.test(String(error.message || error))) {
        context.properties.deleteProperty(context.pendingKey);
        throw new Error('Calendar changed during approval. Review the latest values and try again.');
      }
      throw new Error('Calendar did not confirm the change. Use Finish pending correction to check it before trying again.');
    }
    try {
      return qdpApifyCorrectionComplete_(qdpApifyCorrectionContext_(body.eventId));
    } catch (error) {
      throw new Error('Calendar saved, but the Index write is unconfirmed. Use Finish pending correction. ' + error.message);
    }
  });
}

function qdpApifyCorrectionFinish_(body) {
  return qdpApifyCorrectionWithLock_(function() {
    return qdpApifyCorrectionComplete_(qdpApifyCorrectionContext_(body.eventId));
  });
}
