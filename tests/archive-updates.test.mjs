import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
const source = readFileSync(new URL('../apps-script/ArchiveReview.gs', import.meta.url), 'utf8');
// Core is maintained separately from this repository. Exercise its actual
// shared save rules when the supplied source is available.
function test(name, options, run) {
  if (typeof options === 'function') { run = options; options = {}; }
  return nodeTest(name, {...options, skip: options.skip || (!process.env.QDP_CORE_SOURCE && 'Set QDP_CORE_SOURCE to the installed Core.gs replacement')}, run);
}
import { setup, event, eventHeaders } from './helpers/archive-fixture.mjs';

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
  const updates = h.batchRequests[1].filter(request => request.updateCells?.start.sheetId === h.sheets.get('Events_Archive').getSheetId());
  assert.equal(new Set(updates.map(request => request.updateCells.start.rowIndex)).size, 125);
  assert.equal(new Set(updates.filter(request => request.updateCells.start.columnIndex === eventHeaders.indexOf('ArtistIDs (comma-separated)'))
    .map(request => request.updateCells.start.rowIndex)).size, 125);
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
  assert.equal(h.digestCount - before, page.events.flatMap(e => e.proposals).length * 2 + page.events.length);
});

test('inline event records use stable EventID and source tab after records move', () => {
  const h = setup({events: [event('ONE', 'New Artist'), event('TWO', 'No match')]});
  h.call('scan');
  const sheet = h.sheets.get('Events_Archive');
  [sheet.rows[1], sheet.rows[2]] = [sheet.rows[2], sheet.rows[1]];
  const result = h.call('bootstrap').events[0].record;
  assert.equal(result.eventId, 'ONE'); assert.equal(result.sheet, 'Events_Archive');
  assert.equal(result.fields.find(field => field.label === 'Description').value, 'New Artist');
});

test('review results include the full original description without truncating or stripping line breaks', () => {
  const description = 'New Artist\n\n' + 'Full recorded event copy. '.repeat(90) + '\nLast line of the event.';
  const h = setup({events: [event('ONE', description)]});
  assert.equal(h.call('scan').events[0].description, description);
});

test('one atomic save combines description edits, missed IDs, checked additions, and permanent rejections', () => {
  const h = setup({staleReads: true}), page = h.call('scan'), record = page.events[0].record;
  const result = h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision,
    decision: p.kind === 'artist' ? 'Approve' : 'Reject', proposedIds: p.proposedIds})),
    eventEdits: [{sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision,
      fields: {Description: 'Cleaned description\n\nComplete final line.', 'ArtistIDs (comma-separated)': 'OLD', PartyID: 'NIGHT'}}]});
  assert.equal(h.batchRequests.length, 1);
  const row = h.sheets.get('Events_Archive').rows[1];
  assert.equal(row[eventHeaders.indexOf('Description')], 'Cleaned description\n\nComplete final line.');
  assert.equal(row[eventHeaders.indexOf('ArtistIDs (comma-separated)')], 'OLD, NEW');
  assert.equal(row[eventHeaders.indexOf('PartyID')], 'NIGHT');
  assert.equal(row[eventHeaders.indexOf('QueerArtistIndicator')], 'Yes');
  assert.equal(result.summary.applied, 1); assert.equal(result.summary.rejected, 1);
  assert.equal(result.editedEvents, 1); assert.equal(result.savedEventKeys.length, 1);
  assert.equal(result.events[0].record.fields.find(field => field.label === 'Description').value, 'Cleaned description\n\nComplete final line.');
  assert.equal(result.job.phase, 'saved'); assert.equal(result.needsPublish, true);
  assert.equal(h.call('rejects').rejectedTotal, 1); assert.deepEqual(h.publishes, []);
});

test('event edits alone save across multiple source tabs, including missed associations and old ID removal', () => {
  const h = setup({events: [event('ONE', 'New Artist', {'ArtistIDs (comma-separated)': 'UNRESOLVED'})],
    active: [event('TWO', 'New Artist')]});
  const page = h.call('scan', {includeActive: true});
  const edits = page.events.map(({record}) => ({sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision,
    fields: {Description: 'Cleaned ' + record.eventId, 'ArtistIDs (comma-separated)': 'OLD'}}));
  const saved = h.call('save', {changes: [], eventEdits: edits});
  assert.equal(h.batchRequests.length, 1); assert.equal(saved.editedEvents, 2);
  assert.equal(saved.summary.blocked, 2); assert.equal(saved.summary.applied, 0);
  assert.ok(saved.events.every(event => event.record.fields.find(field => field.label === 'Description').value.startsWith('Cleaned')));
  assert.ok(h.sheets.get('Events').rows[1][eventHeaders.indexOf('LastEditedAt')]);
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('ArtistIDs (comma-separated)')], 'OLD');
  assert.deepEqual(h.publishes, []);
});

test('one stale edited event blocks the whole mixed batch before writing any event or reject decision', () => {
  const h = setup({events: [event('ONE', 'New Artist'), event('TWO', 'New Artist')]}), page = h.call('scan');
  const edits = page.events.map(({record}) => ({sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision,
    fields: {Description: 'My edit'}}));
  h.sheets.get('Events_Archive').rows[2][eventHeaders.indexOf('Description')] = 'Someone else changed this';
  const first = h.proposals(page)[0];
  assert.throws(() => h.call('save', {changes: [{key: first.key, revision: first.revision, decision: 'Reject'}], eventEdits: edits}), /changed since/);
  assert.equal(h.batchRequests.length, 0); assert.equal(h.call('rejects').rejectedTotal, 0);
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')], 'New Artist');
});

test('a manual venue conflicting with a checked venue revision is rejected without writes', () => {
  const h = setup({events: [event('ONE', 'The Room')]}), page = h.call('scan'), record = page.events[0].record;
  const venue = h.proposals(page).find(p => p.kind === 'venue');
  assert.throws(() => h.call('save', {changes: [{key: venue.key, revision: venue.revision, decision: 'Approve', proposedIds: ['ROOM']}],
    eventEdits: [{sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision, fields: {VenueID: 'OTHER'}}]}), /conflicts with a checked revision/);
  assert.equal(h.batchRequests.length, 0);
});

test('inline saves protect formula and identity columns and reject newly invented IDs', () => {
  for (const fields of [{EventID: 'CHANGED'}, {'Title_Public (auto w/ emojis)': 'Override'}, {'ArtistIDs (comma-separated)': 'MADE-UP'}]) {
    const h = setup(), sheet = h.sheets.get('Events_Archive');
    sheet.formulas = [[], []]; sheet.formulas[1][eventHeaders.indexOf('Title_Public (auto w/ emojis)')] = '=A1';
    const record = h.call('scan').events[0].record;
    assert.throws(() => h.call('save', {changes: [], eventEdits: [{sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision, fields}]}), /cannot be edited|Unknown artists|Unknown artist ID/);
    assert.equal(h.batchRequests.length, 0);
  }
});

test('calculated value changes do not conflict with inline edits, while formula expression changes do', () => {
  for (const expressionChanged of [false, true]) {
    const h = setup(), sheet = h.sheets.get('Events_Archive'), column = eventHeaders.indexOf('Title_Public (auto w/ emojis)');
    sheet.formulas = [[], []]; sheet.formulas[1][column] = '=A1';
    const record = h.call('scan').events[0].record;
    sheet.rows[1][column] = 'Recalculated title';
    if (expressionChanged) sheet.formulas[1][column] = '=B1';
    const save = () => h.call('save', {changes: [], eventEdits: [{sheet: record.sheet, eventId: record.eventId,
      expectedRevision: record.revision, fields: {Description: 'Cleaned'}}]});
    if (expressionChanged) { assert.throws(save, /changed since/); assert.equal(h.batchRequests.length, 0); }
    else { assert.equal(save().editedEvents, 1); assert.equal(sheet.rows[1][column], 'Recalculated title'); }
  }
});

test('a renamed inline event updates its result header and remaining suggestions require a new scan', () => {
  const h = setup(), record = h.call('scan').events[0].record;
  const result = h.call('save', {changes: [], eventEdits: [{sheet: record.sheet, eventId: record.eventId,
    expectedRevision: record.revision, fields: {'Title (internal)': 'Clean title'}}]});
  assert.equal(result.events[0].title, 'Clean title');
  assert.ok(result.events[0].proposals.every(p => p.result === 'Event edited; scan again'));
  const fresh = h.call('scan'); assert.equal(fresh.summary.blocked, 0);
});

test('an edited description can save alongside checked venue and dependent queer classification', () => {
  const h = setup({events: [event('ONE', 'The Room')]}); h.sheets.get('Venues').rows[1][6] = 'Yes';
  const page = h.call('scan'), record = page.events[0].record;
  const result = h.call('save', {changes: h.proposals(page).map(p => ({key: p.key, revision: p.revision, decision: 'Approve', proposedIds: p.proposedIds})),
    eventEdits: [{sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision, fields: {Description: 'Clean event details'}}]});
  assert.equal(result.summary.applied, 2); assert.equal(h.batchRequests.length, 1);
  assert.equal(h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('ExplicitQueer (Yes/No)')], 'Yes');
});

test('bulk inline editing reads the source once and rechecks one span rather than fetching each event separately', () => {
  const h = setup({events: Array.from({length: 40}, (_, i) => event('E-' + i, 'New Artist'))});
  const first = h.call('scan'), second = h.call('bootstrap', {offset: 20});
  const edits = [...first.events, ...second.events].map(({record}) => ({sheet: record.sheet, eventId: record.eventId,
    expectedRevision: record.revision, fields: {Description: 'Clean ' + record.eventId}}));
  h.reads.length = 0;
  const result = h.call('save', {changes: [], eventEdits: edits});
  assert.equal(result.editedEvents, 40); assert.equal(h.batchRequests.length, 1);
  assert.equal(h.reads.filter(read => read.sheet === 'Events_Archive' && read.height > 1).length, 2);
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


test('master search reaches every archive tab before any scan and excludes the current Events tab', () => {
  const h = setup({events: [event('BASE', 'Searchneedle base')], active: [event('CURRENT', 'Searchneedle current')],
    extra: {'Archive 2023': [eventHeaders, eventHeaders.map(header => event('YEAR', 'Searchneedle old', {StartDate: '2023-02-01'})[header])]}});
  const page = h.call('bootstrap', {archiveSearch: 'Searchneedle'});
  assert.equal(page.fullArchiveSearch, true); assert.equal(page.scan, null);
  assert.equal(page.totalEvents, 2);
  assert.deepEqual(h.plain(page.events.map(e => e.eventId)), ['BASE', 'YEAR']);
  assert.ok(page.events.every(e => e.record && e.proposals.length === 0));
  assert.equal(h.sheets.has('Archive_ID_Review'), false); assert.equal(h.batchRequests.length, 0);
});

test('master search matches saved fields literally, including descriptions, locations, links, titles, and IDs', () => {
  const h = setup({events: [event('UNIQUE-ID', 'A description with a+b? and house music',
    {'Title (internal)': 'Sunrise special', Location: 'A place near River Street', Flyer_URL: 'https://example.test/flyer/8347.jpg'})]});
  for (const text of ['UNIQUE-ID', 'sunrise', 'HOUSE MUSIC', 'River Street', '/flyer/8347.jpg', 'a+b?']) {
    assert.equal(h.call('bootstrap', {archiveSearch: text}).totalEvents, 1, text);
  }
  assert.equal(h.call('bootstrap', {archiveSearch: 'a.*b'}).totalEvents, 0);
});

test('master search resolves linked profile names without inferring affiliations or unassigned artists', () => {
  const h = setup({events: [event('ONE', 'Ordinary copy', {VenueID: 'ROOM', PartyID: 'NIGHT',
    'ArtistIDs (comma-separated)': 'OLD', 'HostCollectiveIDs (comma-separated)': 'CREW'})]});
  for (const text of ['The Room', 'The Night', 'Existing Artist', 'The Crew']) {
    assert.equal(h.call('bootstrap', {archiveSearch: text}).totalEvents, 1, text);
  }
  assert.equal(h.call('bootstrap', {archiveSearch: 'New Artist'}).totalEvents, 0);
});

test('master search ignores case and accents while preserving a full phrase across whitespace', () => {
  const h = setup({events: [event('ONE', 'SAZÓN brings\n\nwarm grooves.')]});
  assert.equal(h.call('bootstrap', {archiveSearch: 'sazon brings warm'}).totalEvents, 1);
  assert.equal(h.call('bootstrap', {archiveSearch: 'Sazón'}).totalEvents, 1);
});

test('master search ignores the last scan date and profile scope, and review query and status filters', () => {
  const h = setup({events: [event('OLD', 'New Artist searchneedle', {StartDate: '2023-01-01'}),
    event('NEWER', 'New Artist', {StartDate: '2026-01-01'})]});
  h.call('scan', {from: '2026-01-01', kind: 'artist', profileId: 'NEW'});
  const page = h.call('bootstrap', {archiveSearch: 'searchneedle', view: 'applied', query: 'not in this event'});
  assert.equal(page.totalEvents, 1); assert.equal(page.events[0].eventId, 'OLD');
  assert.equal(page.events[0].proposals.length, 0);
});

test('master search retains all suggestions for a matched event and clearing returns to filtered review', () => {
  const h = setup(), scan = h.call('scan');
  const page = h.call('bootstrap', {archiveSearch: 'ONE', view: 'applied', query: 'unmatched'});
  assert.equal(page.events[0].proposals.length, scan.events[0].proposals.length);
  const cleared = h.call('bootstrap', {archiveSearch: '', view: 'applied', query: 'unmatched'});
  assert.equal(cleared.archiveSearch, ''); assert.equal(cleared.totalEvents, 0);
});

test('master search paginates all matches in stable newest-first order', () => {
  const h = setup({events: Array.from({length: 45}, (_, i) => event('E-' + i, 'matchneedle',
    {StartDate: new Date(Date.UTC(2025, 0, i + 1, 12)).toISOString().slice(0, 10)}))});
  const ids = [];
  for (const offset of [0, 20, 40]) {
    const page = h.call('bootstrap', {archiveSearch: 'matchneedle', offset});
    assert.equal(page.totalEvents, 45); assert.equal(page.offset, offset);
    assert.equal(page.events.length, offset === 40 ? 5 : 20);
    ids.push(...page.events.map(e => e.eventId));
  }
  assert.equal(new Set(ids).size, 45); assert.equal(ids[0], 'E-44'); assert.equal(ids.at(-1), 'E-0');
  assert.equal(h.call('bootstrap', {archiveSearch: 'matchneedle', offset: 999}).offset, 40);
});

test('master search reports zero matches and safely clamps pagination', () => {
  const h = setup(), page = h.call('bootstrap', {archiveSearch: 'does not exist', offset: 999});
  assert.equal(page.totalEvents, 0); assert.equal(page.offset, 0); assert.equal(page.events.length, 0);
  assert.throws(() => h.call('bootstrap', {archiveSearch: 'x'.repeat(1001)}), /1,000/);
});

test('master search includes cancelled and unpublished archive records for cleanup', () => {
  const h = setup({events: [event('CANCELLED', 'needle', {Status: 'Cancelled'}),
    event('DELETED', 'needle', {'Title (internal)': '(DELETED ENTRY) old listing'})]});
  assert.equal(h.call('bootstrap', {archiveSearch: 'needle'}).totalEvents, 2);
});

test('master search shows missing and duplicate EventIDs with editing blocked', () => {
  const h = setup({events: [event('', 'needle'), event('DUP', 'needle'), event('DUP', 'different copy')]});
  const page = h.call('bootstrap', {archiveSearch: 'needle'});
  assert.equal(page.totalEvents, 2);
  const missing = page.events.find(e => !e.eventId), duplicate = page.events.find(e => e.eventId === 'DUP');
  assert.match(missing.sourceIssue, /Missing EventID at row 2/); assert.equal(missing.record, undefined);
  assert.match(duplicate.sourceIssue, /duplicated/); assert.equal(duplicate.record, undefined);
});

test('master search omits internal edit metadata and completely blank rows', () => {
  const h = setup({events: [event('ONE', 'ordinary copy', {QDP_EditState: '{"v":1,"owned":[],"pending":[],"rejected":{},"note":"secretneedle"}'})]});
  h.sheets.get('Events_Archive').rows.push(Array(eventHeaders.length).fill(''));
  assert.equal(h.call('bootstrap', {archiveSearch: 'secretneedle'}).totalEvents, 0);
  assert.equal(h.call('bootstrap', {archiveSearch: 'Events_Archive'}).totalEvents, 1);
});

test('master search loads formula data once only for source tabs on the displayed page', () => {
  const h = setup({events: Array.from({length: 20}, (_, i) => event('E-' + i, 'needle', {StartDate: '2026-01-01'})),
    extra: {'Archive 2024': [eventHeaders, eventHeaders.map(header => event('OLDER', 'needle', {StartDate: '2024-01-01'})[header])]}});
  const page = h.call('bootstrap', {archiveSearch: 'needle'});
  assert.equal(page.totalEvents, 21); assert.equal(page.events.length, 20);
  assert.deepEqual(h.formulaReads, ['Events_Archive']);
  for (const name of ['Events_Archive', 'Archive 2024']) {
    assert.equal(h.reads.filter(read => read.sheet === name && read.height > 1).length, 1);
  }
});

test('a result with no scan suggestion saves inline to its archive tab and changes its search membership', () => {
  const h = setup({events: [event('ONE', 'oldneedle description')], active: [event('LIVE', 'Live untouched')]});
  const currentBefore = JSON.stringify(h.sheets.get('Events').rows);
  const record = h.call('bootstrap', {archiveSearch: 'oldneedle'}).events[0].record;
  const result = h.call('save', {archiveSearch: 'oldneedle', changes: [], eventEdits: [{
    sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision, fields: {Description: 'newneedle corrected copy'}}]});
  assert.equal(result.editedEvents, 1); assert.equal(result.totalEvents, 0);
  assert.equal(result.savedEventKeys.length, 1); assert.equal(result.needsPublish, true);
  assert.equal(h.call('bootstrap', {archiveSearch: 'newneedle'}).totalEvents, 1);
  assert.equal(JSON.stringify(h.sheets.get('Events').rows), currentBefore);
  assert.deepEqual(h.publishes, []);
});

test('a stale search-result edit is rejected before any source writes', () => {
  const h = setup(), record = h.call('bootstrap', {archiveSearch: 'ONE'}).events[0].record;
  h.sheets.get('Events_Archive').rows[1][eventHeaders.indexOf('Description')] = 'Newer spreadsheet correction';
  assert.throws(() => h.call('save', {changes: [], eventEdits: [{
    sheet: record.sheet, eventId: record.eventId, expectedRevision: record.revision, fields: {Description: 'stale edit'}}]}), /changed/);
  assert.equal(h.batchRequests.length, 0);
});

test('CollAliases and existing Aliases both contribute to collective matching in Core and archive review', () => {
  const h = setup(), sheet = h.sheets.get('Collectives');
  sheet.rows[0].push('CollAliases'); sheet.rows[1][2] = 'Old Crew Name'; sheet.rows[1].push('Rainbow Union, [UCQ]');
  const lookups = h.c.buildLookupMaps_();
  for (const text of ['Rainbow Union', 'Old Crew Name', 'UCQ']) {
    assert.deepEqual(Array.from(h.c.detectIdsByKeywords_(text, lookups).colls), ['CREW'], text);
    h.c.QDP_ARCHIVE_REQUEST_ = null;
    assert.deepEqual(Array.from(h.c.qdpArchiveMatches_(text, h.c.qdpArchiveLookups_(h.ss).collectives), match => match.id), ['CREW'], text);
  }
  assert.deepEqual(Array.from(h.c.detectIdsByKeywords_('UCQfestival', lookups).colls), []);
});

test('CollAliases is editable through the collective profile and alias changes invalidate old approvals', () => {
  const h = setup(), sheet = h.sheets.get('Collectives');
  sheet.rows[0].push('CollAliases'); sheet.rows[1].push('Rainbow Union');
  const profile = h.c.qdpAdminReadIndexProfile_({kind: 'collective', profileId: 'CREW'});
  assert.equal(profile.fields.find(field => field.key === 'CollAliases').value, 'Rainbow Union');
  const page = h.call('scan'), p = page.events[0].proposals.find(p => p.kind === 'artist');
  sheet.rows[1][4] = 'Updated Union';
  assert.throws(() => h.call('decide', {changes: [{key: p.key, revision: p.revision, decision: 'Approve', proposedIds: p.proposedIds}]}), /Index changed/);
  assert.equal(h.batchRequests.length, 0);
});

