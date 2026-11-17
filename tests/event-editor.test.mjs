import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../admin/event-editor.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin/event.html', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function setup({failSave = false, failRead = false} = {}) {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; this.checked = false; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    add(option) { this.children.push(option); }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    setAttribute(name, value) { this.attributes[name] = value; }
    async emit(name) { for (const handler of this.listeners[name] || []) await handler({preventDefault() {}}); }
  }
  const el = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const requests = [], windowListeners = {};
  const field = (key, type, value, options = {}) => ({key, label: key, type, value, group: 'Event', maxLength: 50000, readOnly: false, ...options});
  const event = {eventId: 'ONE', sheet: 'Archive 2025', revision: 'r1', title: 'Archived night', fields: [
    field('Title', 'text', 'Archived night'), field('Description', 'long', 'Full description\n\n' + 'Unabridged detail. '.repeat(100)),
    field('Start date', 'date', '2025-04-01'), field('Artists', 'artist', 'OLD, UNKNOWN'), field('Venue', 'venue', 'ROOM'),
    field('Location', 'text', 'Existing location', {manualLocation: true}), field('Public title', 'text', 'Calculated title', {readOnly: true})
  ]};
  const references = {artist: [{id: 'OLD', name: 'Existing artist'}, {id: 'NEW', name: 'New artist'}],
    collective: [], venue: [{id: 'ROOM', name: 'The Room'}], party: []};
  const context = vm.createContext({URLSearchParams, Set, Map, Option: class extends Element {
    constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
  }, document: {getElementById: id => {assert.ok(el.has(id), id + ' exists in the actual HTML'); return el.get(id);}, createElement: tag => new Element(tag)},
  window: {location: {search: '?eventId=ONE&sheet=Archive%202025'}, confirm: () => true,
    addEventListener(name, fn) { windowListeners[name] = fn; }, QDPAdminProfiles: {
      neighborhoods: ['South', 'Center City'], message(node, text) { node.textContent = text; }, request: async (action, body) => {
        requests.push({action, body: plain(body)});
        if (action.endsWith('.read') && failRead) throw Error('Unknown archive action.');
        if (action.endsWith('.save')) {
          if (failSave) throw Error('This event changed since you opened it.');
          for (const field of event.fields) if (body.fields[field.key] !== undefined) field.value = body.fields[field.key];
          event.revision = 'r2';
        }
        return {event: plain(event), references: plain(references), needsPublish: action.endsWith('.save')};
      }
    }
  }});
  vm.runInContext(script, context);
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const walk = root => root.children.flatMap(child => [child, ...walk(child)]);
  const labels = () => walk(el.get('eventFields')).filter(node => node.tag === 'label' || node.className === 'field event-multiple');
  const label = name => labels().find(node => node.children[0]?.textContent === name);
  const input = name => label(name).children.at(-1).tag === 'small' ? label(name).children.at(-2) : label(name).children.at(-1);
  const fill = async (name, value) => { input(name).value = value; await el.get('eventForm').emit('input'); };
  return {el, requests, windowListeners, settle, walk, label, input, fill};
}

test('event editor loads the exact archive source and complete description, with no initial changes', async () => {
  const h = setup(); await h.settle();
  assert.deepEqual(h.requests[0], {action: 'admin.archive.event.read', body: {eventId: 'ONE', sheet: 'Archive 2025'}});
  assert.equal(h.input('Description').value, 'Full description\n\n' + 'Unabridged detail. '.repeat(100));
  assert.equal(h.el.get('eventSave').disabled, true);
  assert.equal(h.input('Public title').disabled, true);
  assert.equal(h.input('Location').disabled, true);
});

test('one save sends only edited fields and their original revision and clears only after confirmation', async () => {
  const h = setup(); await h.settle(); await h.fill('Description', 'Edited full\n\ndescription');
  assert.equal(h.el.get('eventSave').disabled, false);
  await h.el.get('eventForm').emit('submit'); await h.settle();
  assert.deepEqual(h.requests[1], {action: 'admin.archive.event.save', body: {eventId: 'ONE', sheet: 'Archive 2025',
    expectedRevision: 'r1', fields: {Description: 'Edited full\n\ndescription'}}});
  assert.equal(h.el.get('eventSave').disabled, true);
  assert.match(h.el.get('eventStatus').textContent, /Event saved/);
});

test('failed saves keep unsaved text, its original revision, and the leave-page guard', async () => {
  const h = setup({failSave: true}); await h.settle(); await h.fill('Description', 'My unsaved revision');
  await h.el.get('eventForm').emit('submit'); await h.settle();
  assert.equal(h.input('Description').value, 'My unsaved revision');
  assert.equal(h.el.get('eventSave').disabled, false);
  const event = {preventDefault() { this.prevented = true; }}; h.windowListeners.beforeunload(event);
  assert.equal(event.prevented, true);
  assert.match(h.el.get('eventStatus').textContent, /changed since/);
});

test('manual location editing unlocks only after the venue is cleared', async () => {
  const h = setup(); await h.settle();
  await h.fill('Venue', ''); assert.equal(h.input('Location').disabled, false);
  await h.fill('Location', 'New manual location');
  await h.el.get('eventForm').emit('submit'); await h.settle();
  assert.deepEqual(h.requests[1].body.fields, {Venue: '', Location: 'New manual location'});
});

test('older deployments get an actionable editor message without redirecting outside Admin', async () => {
  const h = setup({failRead: true}); await h.settle();
  assert.match(h.el.get('eventStatus').textContent, /ArchiveReview.gs v7.4.20/);
  assert.equal(h.requests.length, 1);
});
