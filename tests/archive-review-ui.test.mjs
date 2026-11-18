import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../admin/archive-updates.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin/archive-updates.html', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const proposal = (key, kind = 'artist', added = ['NEW']) => ({key, revision: 'r-' + key, kind,
  currentIds: [], proposedIds: added, state: 'pending', result: 'Ready', matched: 'Recorded lineup', evidence: 'Name in event copy'});

function setup({pages = [[proposal('A')]], failSave = false, incompleteSave = false, incompleteEvents = false, jobPhase = 'ready', separatePublish = true} = {}) {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.attributes = {}; this.dataset = {}; this.checked = false; this.disabled = false; this.textContent = ''; }
    append(...children) { for (const child of children) this.children.push(...(child.tag === 'fragment' ? child.children : [child])); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    add(option) { this.children.push(option); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    async emit(name, fields = {}) { for (const handler of this.listeners[name] || []) await handler({preventDefault() {}, ...fields}); }
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('archiveIncludeActive').checked = true;
  const requests = [], timers = new Map(), windowListeners = {};
  let timerId = 0, needsPublish = false;
  const rejects = [];
  const events = pages.map((proposals, i) => ({eventId: 'EVENT-' + i, title: 'Night ' + i, sheet: 'Archive 2025',
    date: '2025-04-01', description: 'Full event description\n\n' + 'A complete event detail. '.repeat(40) + '\nFinal detail.', proposals}));
  for (const event of events) event.record = {eventId: event.eventId, sheet: event.sheet, title: event.title, revision: 'event-r-' + event.eventId,
    fields: [
      ['Title', 'Title', 'text', event.title], ['Description', 'Description', 'long', event.description],
      ['ArtistIDs', 'Artists', 'artist', ''], ['HostCollectiveIDs', 'Collectives', 'collective', ''],
      ['VenueID', 'Venue', 'venue', ''], ['PartyID', 'Party', 'party', ''], ['Location', 'Location', 'text', 'Existing location'],
      ['StartDate', 'Start date', 'date', '2025-04-01'], ['PublicTitle', 'Public title', 'text', 'Calculated title']
    ].map(([key, label, type, value]) => ({key, label, type, value, maxLength: 50000,
      readOnly: key === 'PublicTitle', manualLocation: key === 'Location'}))};
  const payload = data => {
    const offset = Math.max(0, Math.min(events.length - 1, data.offset || 0));
    const summary = {pending: 0, approved: 0, applied: 0, rejected: 0, blocked: 0};
    for (const event of events) for (const p of event.proposals) summary[p.state]++;
    return {ok: 'yes', events: [events[offset]], totalEvents: events.length, pageSize: 1, offset, summary,
      scan: {scanned: events.length, total: events.length, proposed: 4}, scanInProgress: jobPhase === 'scanning', job: {phase: jobPhase},
      references: {artist: [{id: 'NEW', name: 'New Artist'}, {id: 'MISSED', name: 'Missed Artist'}], collective: [],
        venue: [{id: 'ROOM', name: 'The Room'}], party: []}, needsPublish, separatePublish, inlineEventEdits: true,
      ...(data.includeRejects ? {rejectedTotal: rejects.length, rejectOffset: 0, rejects} : {})};
  };
  const context = vm.createContext({URL, Intl, Date, Map, Set, TextEncoder, Option: class extends Element {
    constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
  }, document: {getElementById: id => {
    assert.ok(elements.has(id), 'Every script control exists in the actual HTML: ' + id); return elements.get(id);
  }, createElement: tag => new Element(tag), createTextNode: text => ({tag: 'text', textContent: text}),
  createDocumentFragment: () => new Element('fragment')},
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  window: {confirm: () => true, addEventListener(name, fn) { windowListeners[name] = fn; }, QDPAdminProfiles: {
    message(node, text) { node.textContent = text; }, request: async (action, data) => {
      requests.push({action, data: plain(data)});
      if (action === 'admin.archive.save') {
        if (failSave) throw new Error('Network response interrupted');
        if (incompleteSave) return payload(data);
        for (const change of data.changes) for (const event of events) for (const p of event.proposals) if (p.key === change.key) {
          p.state = change.decision === 'Approve' ? 'applied' : change.decision === 'Reject' ? 'rejected' : 'pending';
          if (change.decision === 'Reject') rejects.push({key: p.key, title: event.title, eventId: event.eventId, field: 'ArtistIDs', value: 'NEW'});
          if (change.decision === 'Approve') needsPublish = true;
          p.revision += '-saved';
          if (change.proposedIds) p.proposedIds = change.proposedIds;
        }
        jobPhase = 'saved';
      for (const edit of data.eventEdits || []) {
        const event = events.find(event => event.eventId === edit.eventId && event.sheet === edit.sheet);
        for (const field of event.record.fields) if (edit.fields[field.key] !== undefined) field.value = edit.fields[field.key];
        event.record.revision += '-saved'; needsPublish = true;
      }
      return {...payload(data), saved: data.changes.length, savedKeys: data.changes.map(change => change.key),
        ...(!incompleteEvents ? {savedEventKeys: data.eventEdits.map(edit => JSON.stringify([edit.sheet, edit.eventId]))} : {}), editedEvents: data.eventEdits.length};
      }
      if (action === 'admin.archive.rejects') return {rejectedTotal: rejects.length, rejectOffset: 0, rejects};
      if (action === 'admin.archive.step' && data.progressOnly) {
        const full = payload(data);
        return {progressOnly: true, scan: {...full.scan, scanned: 2}, job: full.job, scanInProgress: true, needsPublish};
      }
      if (action === 'admin.archive.publish') { jobPhase = 'publishing-live'; return payload(data); }
      return payload(data);
    }
  }}});
  vm.runInContext(source, context);
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const all = root => root.children.flatMap(child => [child, ...all(child)]);
  const find = (rootId, predicate) => all(elements.get(rootId)).filter(predicate);
  const candidates = () => find('archiveEvents', child => child.className === 'archive-candidate').map(label => label.children[0]);
  const buttons = text => find('archiveEvents', child => child.tag === 'button' && child.textContent === text);
  const change = async (input, checked) => { input.checked = checked; await input.emit('change'); await settle(); };
  const field = (label, event = 'EVENT-0') => find('archiveEvents', child => child.attributes?.['aria-label'] === label + ' · ' + event)[0];
  const fill = async (label, value, event) => { const input = field(label, event); input.value = value; await input.emit('input'); await settle(); };
  const openDetails = async () => { const more = find('archiveEvents', child => child.className === 'archive-inline-more')[0]; more.open = true; await more.emit('toggle'); await settle(); };
  return {elements, requests, context, settle, find, candidates, buttons, change, windowListeners, timers, field, fill, openDetails};
}

test('every proposed change starts unchecked, and checking or rejecting performs no write', async () => {
  const h = setup({pages: [[proposal('A'), proposal('V', 'venue', ['ROOM']), proposal('P', 'party', ['X', 'Y'])]]});
  await h.settle();
  assert.ok(h.candidates().every(input => input.checked === false));
  assert.equal(h.elements.get('archiveSave').disabled, true);
  await h.change(h.candidates()[0], true);
  await h.buttons('Reject suggestion')[1].emit('click');
  assert.deepEqual(h.requests.map(r => r.action), ['admin.archive.bootstrap']);
  assert.match(h.elements.get('archiveDraftCount').textContent, /2 unsaved/);
});

test('selections survive pagination and refresh and save in one request across all pages', async () => {
  const h = setup({pages: [[proposal('A')], [proposal('B')]]});
  await h.settle(); await h.change(h.candidates()[0], true);
  await h.elements.get('archiveNext').emit('click'); await h.settle();
  assert.equal(h.candidates()[0].checked, false);
  await h.change(h.candidates()[0], true);
  await h.elements.get('archiveRefresh').emit('click'); await h.settle();
  assert.equal(h.candidates()[0].checked, true);
  await h.elements.get('archivePrevious').emit('click'); await h.settle();
  assert.equal(h.candidates()[0].checked, true);
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  const writes = h.requests.filter(r => r.action === 'admin.archive.save');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data.changes.map(change => change.key), ['A', 'B']);
  assert.equal(h.requests.some(r => r.action === 'admin.archive.decide' || r.action === 'admin.archive.apply'), false);
  assert.match(h.elements.get('archiveDraftCount').textContent, /Check the revisions/);
});

test('partial artist approval preserves old IDs and single-value choices remain exclusive and clearable', async () => {
  const artist = {...proposal('A', 'artist', ['OLD', 'ONE', 'TWO']), currentIds: ['OLD']};
  const h = setup({pages: [[artist, proposal('V', 'venue', ['X', 'Y'])]]});
  await h.settle(); const inputs = h.candidates();
  await h.change(inputs[1], true);
  await h.change(inputs[2], true); await h.change(inputs[3], true);
  assert.equal(inputs[2].checked, false); assert.equal(inputs[3].checked, true);
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  const changes = h.requests.find(r => r.action === 'admin.archive.save').data.changes;
  assert.deepEqual(changes[0].proposedIds, ['OLD', 'TWO']);
  assert.deepEqual(changes[1].proposedIds, ['Y']);
});

test('failed or unconfirmed saves retain every checked revision', async () => {
  for (const options of [{failSave: true}, {incompleteSave: true}]) {
    const h = setup(options); await h.settle(); await h.change(h.candidates()[0], true);
    await h.elements.get('archiveSave').emit('click'); await h.settle();
    assert.equal(h.candidates()[0].checked, true);
    assert.match(h.elements.get('archiveDraftCount').textContent, /1 unsaved/);
    assert.equal(h.elements.get('archiveSave').disabled, false);
  }
});

test('unchecked and cleared revisions never get sent, and check-page skips ambiguous venues', async () => {
  const h = setup({pages: [[proposal('A'), proposal('V', 'venue', ['X', 'Y'])]]});
  await h.settle();
  await h.change(h.elements.get('archiveSelectPage'), true);
  assert.deepEqual(h.candidates().map(c => c.checked), [true, false, false]);
  await h.change(h.candidates()[0], false);
  assert.equal(h.elements.get('archiveSave').disabled, true);
  await h.change(h.candidates()[0], true);
  await h.elements.get('archiveClear').emit('click');
  assert.equal(h.elements.get('archiveSave').disabled, true);
  assert.ok(h.candidates().every(c => c.checked === false));
  assert.equal(h.requests.length, 1);
});

test('results show the complete description in an inline editor with no separate edit-page link', async () => {
  const h = setup(); await h.settle();
  assert.equal(h.find('archiveEvents', child => child.className === 'archive-edit-event').length, 0);
  assert.equal(h.field('Description').value, 'Full event description\n\n' + 'A complete event detail. '.repeat(40) + '\nFinal detail.');
  await h.change(h.candidates()[0], true);
  const event = {preventDefault() { this.prevented = true; }};
  h.windowListeners.beforeunload(event);
  assert.equal(event.prevented, true);
});

test('Start new scan sends a fresh scan immediately, without confirmation or saving local decisions', async () => {
  const h = setup({pages: [[proposal('A'), proposal('B')]]}); await h.settle();
  h.context.window.confirm = () => { throw new Error('A new scan must not ask for confirmation'); };
  await h.change(h.candidates()[0], true);
  await h.buttons('Reject suggestion')[1].emit('click');
  h.elements.get('archiveView').value = 'approved'; h.elements.get('archiveQuery').value = 'Old review search';
  await h.elements.get('archiveScanForm').emit('submit'); await h.settle();
  const scan = h.requests.find(r => r.action === 'admin.archive.scan');
  assert.ok(scan);
  assert.equal(scan.data.offset, 0); assert.equal(scan.data.view, ''); assert.equal(scan.data.query, '');
  assert.equal(h.requests.some(r => ['admin.archive.save', 'admin.archive.decide'].includes(r.action)), false);
  assert.ok(h.candidates().every(input => input.checked === false));
  assert.match(h.elements.get('archiveDraftCount').textContent, /Check the revisions/);
});

test('Start new scan remains available while another scan is running', async () => {
  const h = setup({jobPhase: 'scanning'}); await h.settle();
  assert.equal(h.elements.get('archiveScanFields').disabled, false);
  await h.elements.get('archiveScanForm').emit('submit'); await h.settle();
  assert.equal(h.requests.filter(r => r.action === 'admin.archive.scan').length, 1);
});

test('saving an approval never publishes until Publish saved changes is pressed', async () => {
  const h = setup(); await h.settle();
  await h.change(h.candidates()[0], true);
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  assert.equal(h.requests.some(r => r.action === 'admin.archive.publish'), false);
  assert.equal(h.elements.get('archivePublish').disabled, false);
  assert.match(h.elements.get('archivePublishNote').textContent, /awaiting publication/);
  await h.elements.get('archivePublish').emit('click'); await h.settle();
  assert.equal(h.requests.filter(r => r.action === 'admin.archive.publish').length, 1);
});

test('an older deployment cannot receive a save that would automatically publish', async () => {
  const h = setup({separatePublish: false}); await h.settle();
  await h.change(h.candidates()[0], true);
  assert.equal(h.elements.get('archiveSave').disabled, true);
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  assert.equal(h.requests.some(r => r.action === 'admin.archive.save'), false);
  assert.match(h.elements.get('archiveStatus').textContent, /v7.4.22/);
  assert.equal(h.candidates()[0].checked, true);
});

test('saving a rejection updates its open saved list in the same response', async () => {
  const h = setup(); await h.settle();
  h.elements.get('archiveRejectDetails').open = true;
  await h.elements.get('archiveRejectDetails').emit('toggle'); await h.settle();
  await h.buttons('Reject suggestion')[0].emit('click');
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  assert.match(h.elements.get('archiveRejectStatus').textContent, /1 saved rejected/);
  assert.equal(h.elements.get('archiveRejectList').children.length, 1);
  assert.equal(h.find('archiveRejectList', child => child.tag === 'button')[0].disabled, false);
  assert.equal(h.requests.filter(r => r.action === 'admin.archive.rejects').length, 1);
});

test('scan progress leaves event controls attached instead of rebuilding the whole results page', async () => {
  const h = setup({jobPhase: 'scanning'}); await h.settle();
  const candidate = h.candidates()[0];
  await [...h.timers.values()][0](); await h.settle();
  assert.equal(h.requests.at(-1).data.progressOnly, true);
  assert.equal(h.candidates()[0], candidate);
  assert.equal(h.elements.get('archiveProgress').value, 2);
});

test('description edits survive pagination and refresh and join checked revisions in one save', async () => {
  const h = setup({pages: [[proposal('A')], [proposal('B')]]}); await h.settle();
  await h.fill('Description', 'Cleaned event zero\n\nFinal detail.');
  await h.change(h.candidates()[0], true);
  await h.elements.get('archiveNext').emit('click'); await h.settle();
  await h.fill('Description', 'Cleaned event one', 'EVENT-1');
  await h.elements.get('archivePrevious').emit('click'); await h.settle();
  await h.elements.get('archiveRefresh').emit('click'); await h.settle();
  assert.equal(h.field('Description').value, 'Cleaned event zero\n\nFinal detail.');
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  const request = h.requests.find(request => request.action === 'admin.archive.save');
  assert.equal(request.data.eventEdits.length, 2); assert.equal(request.data.changes.length, 1);
  assert.equal(request.data.eventEdits[0].expectedRevision, 'event-r-EVENT-0');
  assert.equal(h.requests.filter(request => request.action === 'admin.archive.save').length, 1);
  assert.match(h.elements.get('archiveDraftCount').textContent, /Check the revisions/);
  assert.equal(h.requests.some(request => request.action === 'admin.archive.publish'), false);
});

test('missed artist associations can be selected directly without checking a scan proposal', async () => {
  const h = setup(); await h.settle(); await h.openDetails();
  const picker = h.field('Artists').children[0]; picker.open = true; await picker.emit('toggle');
  const label = h.find('archiveEvents', child => child.className === 'archive-id-option' && child.children[1].textContent.includes('MISSED'))[0];
  await h.change(label.children[0], true);
  await h.elements.get('archiveSave').emit('click'); await h.settle();
  const request = h.requests.find(request => request.action === 'admin.archive.save');
  assert.equal(request.data.changes.length, 0); assert.equal(request.data.eventEdits[0].fields.ArtistIDs, 'MISSED');
});

test('failed or incomplete event saves retain both direct edits and checked revisions', async () => {
  for (const options of [{failSave: true}, {incompleteEvents: true}]) {
    const h = setup(options); await h.settle(); await h.fill('Description', 'Keep this edit');
    await h.change(h.candidates()[0], true);
    await h.elements.get('archiveSave').emit('click'); await h.settle();
    assert.equal(h.field('Description').value, 'Keep this edit'); assert.equal(h.candidates()[0].checked, true);
    assert.match(h.elements.get('archiveDraftCount').textContent, /2 unsaved/);
  }
});

test('formula fields and linked locations stay protected, and clearing all restores original field values', async () => {
  const h = setup(); await h.settle(); await h.openDetails();
  assert.equal(h.field('Public title').disabled, true);
  await h.fill('Venue', 'ROOM'); assert.equal(h.field('Location').disabled, true);
  await h.fill('Description', 'Discard this');
  await h.elements.get('archiveClear').emit('click'); await h.settle();
  assert.equal(h.field('Venue').value, ''); assert.equal(h.field('Location').disabled, false);
  assert.ok(h.field('Description').value.startsWith('Full event description'));
  assert.equal(h.elements.get('archiveSave').disabled, true);
});

test('starting a new scan discards inline drafts without saving them', async () => {
  const h = setup(); await h.settle(); await h.fill('Description', 'Unsaved cleanup');
  const event = {preventDefault() { this.prevented = true; }}; h.windowListeners.beforeunload(event); assert.equal(event.prevented, true);
  await h.elements.get('archiveScanForm').emit('submit'); await h.settle();
  assert.ok(h.field('Description').value.startsWith('Full event description'));
  assert.equal(h.requests.some(request => request.action === 'admin.archive.save'), false);
});
