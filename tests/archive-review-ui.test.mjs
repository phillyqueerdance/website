import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../admin/archive-updates.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin/archive-updates.html', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const proposal = (key, kind = 'artist', added = ['NEW']) => ({key, revision: 'r-' + key, kind,
  currentIds: [], proposedIds: added, state: 'pending', result: 'Ready', matched: 'Recorded lineup', evidence: 'Name in event copy'});

function setup({pages = [[proposal('A')]], failSave = false, incompleteSave = false} = {}) {
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
  let timerId = 0;
  const events = pages.map((proposals, i) => ({eventId: 'EVENT-' + i, title: 'Night ' + i, sheet: 'Archive 2025',
    date: '2025-04-01', description: 'Full event description\n\n' + 'A complete event detail. '.repeat(40) + '\nFinal detail.', proposals}));
  const payload = data => {
    const offset = Math.max(0, Math.min(events.length - 1, data.offset || 0));
    const summary = {pending: 0, approved: 0, applied: 0, rejected: 0, blocked: 0};
    for (const event of events) for (const p of event.proposals) summary[p.state]++;
    return {ok: 'yes', events: [events[offset]], totalEvents: events.length, pageSize: 1, offset, summary,
      scan: {scanned: events.length, total: events.length, proposed: 4}, scanInProgress: false, job: {phase: 'ready'},
      references: {artist: [{id: 'NEW', name: 'New Artist'}]}, needsPublish: false};
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
          p.state = change.decision === 'Approve' ? 'approved' : change.decision === 'Reject' ? 'rejected' : 'pending';
          p.revision += '-saved';
          if (change.proposedIds) p.proposedIds = change.proposedIds;
        }
        return {...payload(data), saved: data.changes.length, savedKeys: data.changes.map(change => change.key)};
      }
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
  return {elements, requests, context, settle, find, candidates, buttons, change, windowListeners};
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

test('results display the full description and open the Admin event editor separately without losing choices', async () => {
  const h = setup(); await h.settle();
  const link = h.find('archiveEvents', child => child.className === 'archive-edit-event')[0];
  assert.equal(link.href, '/admin/event.html?eventId=EVENT-0&sheet=Archive%202025');
  assert.equal(link.target, '_blank');
  const description = h.find('archiveEvents', child => child.className === 'archive-event-description')[0];
  assert.equal(description.children[1].textContent, 'Full event description\n\n' + 'A complete event detail. '.repeat(40) + '\nFinal detail.');
  await h.change(h.candidates()[0], true);
  const event = {preventDefault() { this.prevented = true; }};
  h.windowListeners.beforeunload(event);
  assert.equal(event.prevented, true);
});
