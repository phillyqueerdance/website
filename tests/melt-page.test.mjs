import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const archive = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const datesSource = archive.slice(archive.indexOf('  async function loadMeltDates()'),
  archive.indexOf('\n  function sortProfiles('));
const shareSource = app.slice(app.indexOf('async function shareMelt('),
  app.indexOf('\nasync function shareEvent('));
const now = Date.parse('2026-11-26T01:00:00Z');

function node(tag, className = '', textContent = '') {
  return { tag, className, textContent, children: [], attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = children; },
    appendChild(child) { this.children.push(child); }
  };
}

function datesFixture(payload) {
  const links = node('div');
  const context = vm.createContext({ node, Date: class extends Date {
    static now() { return now; }
  }, Intl, document: { getElementById: () => links },
    load: async (kind, id) => {
      assert.equal(kind, 'party');
      assert.equal(id, 'MELT-001');
      return payload;
    },
    eventIdOf: event => event.eventId,
    sortEvents: events => [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    archiveUrl: (kind, id) => new URL(`https://qdp.example/?archive=${kind}&id=${id}`),
    retryButton: retry => Object.assign(node('button'), { retry })
  });
  vm.runInContext(datesSource, context);
  return { links, context };
}

test('Melt dates include future and ongoing nights before the most recent archive dates', async () => {
  const f = datesFixture({ profile: { id: 'MELT-001' }, events: [
    { eventId: 'FEB', start: '2027-02-20T21:00:00-05:00' },
    { eventId: 'AUG', start: '2026-08-15T21:00:00-04:00' },
    { eventId: 'INVALID', start: 'invalid' },
    { eventId: 'DEC', start: '2026-12-19T21:00:00-05:00' },
    { eventId: 'ONGOING', start: '2026-11-25T19:00:00-05:00', end: '2026-11-26T02:00:00-05:00' },
    { eventId: 'OCT', start: '2026-10-17T21:00:00-04:00' },
    { eventId: '', start: '2026-11-27T21:00:00-05:00' }
  ] });
  await f.context.loadMeltDates();
  assert.deepEqual(f.links.children.map(link => new URL(link.href).searchParams.get('event')),
    ['ONGOING', 'DEC', 'FEB', 'OCT', 'AUG']);
  assert.equal(f.links.children[1].textContent, 'Dec 19, 2026');
  assert.equal(f.links.children[1].attributes['data-archive-link'], '');
  assert.equal(f.links.attributes['aria-busy'], 'false');
});

test('Melt date errors offer a retry and empty responses describe all dates', async () => {
  const empty = datesFixture({ profile: { id: 'MELT-001' }, events: [] });
  await empty.context.loadMeltDates();
  assert.equal(empty.links.children[0].textContent, 'No dates listed yet.');
  const failed = datesFixture({ error: 'Unavailable' });
  await failed.context.loadMeltDates();
  assert.equal(failed.links.children[0].textContent, 'Dates unavailable. Try again');
  assert.equal(typeof failed.links.children[0].retry, 'function');
  assert.equal(failed.links.attributes['aria-busy'], 'false');
});

function shareFixture(share, copyFails = false) {
  const shared = [], copied = [], timers = [];
  const status = { textContent: '', isConnected: true };
  const context = vm.createContext({ URL,
    location: { origin: 'https://qdp.example', href: 'https://qdp.example/?event=OTHER#melt' },
    navigator: share ? { share: async payload => { shared.push(payload); await share(); } } : {},
    copyEventLink: async url => { if (copyFails) throw Error('Unavailable'); copied.push(url); },
    setTimeout: callback => timers.push(callback)
  });
  vm.runInContext(shareSource, context);
  return { context, status, shared, copied, timers };
}

test('Melt shares its own page through native sharing or the existing clipboard fallback', async () => {
  const native = shareFixture(async () => {});
  await native.context.shareMelt(native.status);
  assert.equal(native.shared[0].url, 'https://qdp.example/#melt');
  assert.equal(native.shared[0].title, 'Melt | Queer Dance Philly');
  assert.deepEqual(native.copied, []);
  for (const share of [undefined, async () => { throw Error('Unsupported'); }]) {
    const fallback = shareFixture(share);
    await fallback.context.shareMelt(fallback.status);
    assert.deepEqual(fallback.copied, ['https://qdp.example/#melt']);
    assert.equal(fallback.status.textContent, 'Link copied');
    fallback.timers[0]();
    assert.equal(fallback.status.textContent, '');
  }
});

test('cancelling Melt sharing does not copy a link, and clipboard failures give feedback', async () => {
  const cancelled = shareFixture(async () => { throw Object.assign(Error('Cancelled'), { name: 'AbortError' }); });
  await cancelled.context.shareMelt(cancelled.status);
  assert.deepEqual(cancelled.copied, []);
  assert.equal(cancelled.status.textContent, '');
  const failed = shareFixture(undefined, true);
  await failed.context.shareMelt(failed.status);
  assert.equal(failed.status.textContent, 'Could not copy link');
});
