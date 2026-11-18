import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../admin/archive-backfill.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin/archive-backfill.html', import.meta.url), 'utf8');
const busyMessage = 'Another QDP save or sync is running. Your changes have not been saved; try again when it finishes.';
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup({count = 1, failKey = '', ingestErrors = [], unmatched = false, flyerReadOnly = false, omitFlyer = false} = {}) {
  class Element {
    constructor(tag) {
      Object.assign(this, {tag, children: [], listeners: {}, value: '', attributes: {}, checked: false,
        disabled: false, textContent: '', files: [], hidden: false});
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    toggleAttribute(key, value) { if (value) this.attributes[key] = ''; else delete this.attributes[key]; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    async emit(name) { for (const fn of this.listeners[name] || []) await fn({preventDefault() {}}); }
    get childNodes() { return this.children; }
  }
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"/g)]
    .map(m => [m[2], new Element(m[1])]));
  const all = root => root.children.flatMap(child => [child, ...all(child)]);
  const get = name => elements.get('backfill' + name);
  const requests = [], timers = [];
  const records = {workflowVersion: 2, items: [], sources: {}, targets: {}, nextOffset: null, sourceCount: count,
    runs: [], needsPublish: false};
  for (let i = 1; i <= count; i++) {
    const eventId = 'EV-' + i, postId = String(12340 + i);
    const sheet = 'Archive 2025';
    const target = {sheet, eventId, revision: 'event-r1', title: 'Current event ' + i, fields: [
      {key: 'Title (internal)', value: 'Current event ' + i},
      {key: 'Description', value: 'Existing description'},
      ...(!omitFlyer ? [{key: 'Flyer_URL', value: '', readOnly: flyerReadOnly}] : [])
    ]};
    records.targets[JSON.stringify([sheet, eventId])] = target;
    records.sources['ig:' + postId] = {key: 'ig:' + postId, account: 'example',
      url: 'https://www.instagram.com/p/Example/', caption: 'Original caption',
      media: [{id: postId, order: 1, url: 'https://images.example/source.jpg', savedUrl: ''}]};
    records.items.push({key: 'candidate:' + i, revision: 'r1', runId: '2025', indexSignature: 'index-r1',
      fields: {'Title (internal)': 'Proposed event ' + i, Description: ''},
      state: 'pending', selectedFields: [], draftDescription: '', visual: {status: 'inspected'},
      evidence: {notes: 'Venue and date match'}, postKeys: ['ig:' + postId],
      matches: unmatched ? [] : [{sheet, eventId, title: target.title, date: '2025-03-01', reasons: ['Same date'], conflicts: []}]});
  }
  const message = (node, text, error = false) => { node.textContent = text; node.toggleAttribute('data-error', error); };
  const context = vm.createContext({
    URL, Blob, TextEncoder, clearTimeout() {}, setTimeout: (fn, delay) => {timers.push({fn, delay}); return timers.length;},
    document: {
      getElementById: id => {assert.ok(elements.has(id), id + ' exists in the HTML'); return elements.get(id);},
      createElement: tag => new Element(tag),
      querySelectorAll: () => [...elements.values(), ...all(get('Items'))].filter(n => ['button', 'input', 'textarea', 'select'].includes(n.tag))
    },
    window: {location: {origin: 'https://qdp.example'}, addEventListener() {}, QDPAdminProfiles: {
      message,
      request: async (action, body = {}) => {
        requests.push({action, body: JSON.parse(JSON.stringify(body))});
        if (action === 'admin.backfill.bootstrap') return structuredClone(records);
        if (action === 'admin.backfill.find') return {events: [Object.values(records.targets).at(-1)]};
        if (action === 'admin.backfill.ingest') {
          const error = ingestErrors.shift();
          if (error) throw error;
          return {addedPosts: body.posts?.length || 0, addedCandidates: body.candidates?.length || 0};
        }
        if (action === 'admin.backfill.savebatch') {
          const results = body.changes.map(change => {
            if (change.key === failKey) return {key: change.key, error: 'Source image unavailable. Choose its downloaded original.'};
            const item = records.items.find(item => item.key === change.key);
            return {key: change.key, state: change.state === 'confirmed' ? 'applied' : change.state,
              revision: 'r2', selectedFields: [], fields: item.fields, result: 'Saved',
              target: records.targets[JSON.stringify([change.targetSheet, change.targetEventId])]};
          });
          return {sources: [], results, editedEvents: results.filter(r => r.state === 'applied').length, needsPublish: true};
        }
        throw new Error('Unexpected action: ' + action);
      }
    }}
  });
  vm.runInContext(source, context);
  const find = fn => all(get('Items')).filter(fn);
  const buttons = label => find(n => n.tag === 'button' && n.textContent === label);
  return {get, requests, timers, find, buttons};
}

test('reviewing across pages queues match and flyer selections locally and saves them in one request', async () => {
  const h = setup({count: 16});
  await settle();
  assert.equal(h.find(n => n.tag === 'article').length, 15);
  assert.equal(h.find(n => n.tag === 'img')[0].src, '/admin/flyer?url=https%3A%2F%2Fimages.example%2Fsource.jpg');
  assert.equal(h.find(n => n.tag === 'a' && n.textContent === 'Open current event')[0].href, 'https://qdp.example/?event=EV-1');
  assert.ok(h.find(n => n.type === 'checkbox').every(n => !n.checked));
  await h.buttons('Approve match + flyer')[0].emit('click');
  await h.get('Next').emit('click');
  await h.buttons('Approve match + flyer')[0].emit('click');
  assert.equal(h.get('Save').textContent, 'Save all changes (2)');
  assert.deepEqual(h.requests.map(r => r.action), ['admin.backfill.bootstrap']);
  await h.get('Save').emit('click');
  assert.deepEqual(h.requests.map(r => r.action), ['admin.backfill.bootstrap', 'admin.backfill.savebatch']);
  const changes = h.requests[1].body.changes;
  assert.deepEqual(changes.map(change => change.targetEventId), ['EV-1', 'EV-16']);
  assert.ok(changes.every(change => change.flyer.postKey && change.selectedFields.join(',') === 'Flyer_URL'));
  assert.equal(h.get('Publish').hidden, false);
  assert.equal(h.get('Save').disabled, true);
});

test('choosing a different suggested record and dismissing another proposal are local decisions', async () => {
  const h = setup({count: 2});
  await settle();
  const match = h.find(n => n.className === 'backfill-match')[0];
  await match.emit('click');
  await h.buttons('Reject')[1].emit('click');
  assert.equal(h.requests.length, 1);
  await h.get('Save').emit('click');
  assert.deepEqual(h.requests[1].body.changes.map(change => change.state), ['confirmed', 'rejected']);
  assert.deepEqual(h.requests[1].body.changes[0].selectedFields, []);
});

test('successful rows clear and a failed flyer stays queued with its explanation', async () => {
  const h = setup({count: 2, failKey: 'candidate:1'});
  await settle();
  for (const button of h.buttons('Approve match + flyer')) await button.emit('click');
  await h.get('Save').emit('click');
  assert.equal(h.get('Save').textContent, 'Save all changes (1)');
  assert.match(h.get('SaveStatus').textContent, /1 still queued/);
  assert.match(h.find(n => n.className === 'backfill-notice')[0].textContent, /downloaded original/);
  await h.get('Save').emit('click');
  assert.deepEqual(h.requests.at(-1).body.changes.map(change => change.key), ['candidate:1']);
});

test('selecting a blank description queues a draft request and leaves the text empty', async () => {
  const h = setup();
  await settle();
  const input = h.find(n => n.tag === 'textarea')[0];
  assert.equal(input.readOnly, true);
  const check = h.find(n => n.type === 'checkbox').at(-1);
  check.checked = true;
  await check.emit('change');
  assert.equal(input.readOnly, false);
  assert.equal(h.requests.length, 1);
  await h.get('Save').emit('click');
  const change = h.requests[1].body.changes[0];
  assert.deepEqual(change.selectedFields, ['Description']);
  assert.equal(change.draftDescription, '');
});

test('source collection import uses large batches and resumes at the failed batch', async () => {
  const h = setup({ingestErrors: [null, new Error('Network interrupted')]});
  await settle();
  const posts = Array.from({length: 521}, (_, i) => ({pk: String(123450 + i)}));
  h.get('Import').files = [{size: 10000, text: async () =>
    JSON.stringify({schema: 'qdp-backfill-v1', runId: 'fixture', posts, candidates: []})}];
  await h.get('Import').emit('change');
  assert.equal(h.get('Progress').value, 500);
  assert.equal(h.get('Resume').hidden, false);
  await h.get('Resume').emit('click');
  const batches = h.requests.filter(r => r.action === 'admin.backfill.ingest');
  assert.deepEqual(batches.map(r => r.body.posts.length), [500, 21, 21]);
  assert.deepEqual(batches[1].body, batches[2].body);
  assert.match(h.get('Status').textContent, /521 new source posts/);
});

test('a busy write retries the exact import batch and completes', async () => {
  const h = setup({ingestErrors: [new Error(busyMessage)]});
  await settle();
  h.get('Import').files = [{size: 1000, text: async () =>
    JSON.stringify({schema: 'qdp-backfill-v1', runId: 'fixture', posts: [{pk: '12345'}], candidates: []})}];
  const importing = h.get('Import').emit('change');
  await settle();
  assert.equal(h.timers.length, 1);
  assert.match(h.get('Status').textContent, /Waiting for the current QDP save or sync/);
  h.timers[0].fn();
  await importing;
  const batches = h.requests.filter(r => r.action === 'admin.backfill.ingest');
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].body, batches[1].body);
  assert.equal(h.get('Resume').hidden, true);
});

test('an unmatched proposal explains why approval is unavailable and enables it after choosing a found event', async () => {
  const h = setup({unmatched: true});
  await settle();
  const approve = h.buttons('Approve match + flyer')[0];
  assert.equal(approve.disabled, true);
  const hint = h.find(element => element.className === 'backfill-meta backfill-flyer-availability')[0];
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /Choose an archive event/);
  const search = h.find(element => element.tag === 'input' && element.placeholder === 'Search 2025 archive events')[0];
  search.value = 'EV-1';
  await h.buttons('Find archive event')[0].emit('click');
  await h.find(element => element.className === 'backfill-match')[0].emit('click');
  assert.equal(approve.disabled, false);assert.equal(hint.hidden, true);
  await approve.emit('click');
  assert.equal(h.get('Save').textContent, 'Save all changes (1)');
  assert.deepEqual(h.requests.map(request => request.action), ['admin.backfill.bootstrap', 'admin.backfill.find']);
});

test('calculated flyer fields and older deployments show the reason for a disabled approval', async () => {
  for (const [options, reason] of [[{flyerReadOnly: true}, /contains a formula/], [{omitFlyer: true}, /ArchiveBackfill.gs v1.1.1/]]) {
    const h = setup(options);await settle();
    assert.equal(h.buttons('Approve match + flyer')[0].disabled, true);
    const hint = h.find(element => element.className === 'backfill-meta backfill-flyer-availability')[0];
    assert.equal(hint.hidden, false);assert.match(hint.textContent, reason);
  }
});
