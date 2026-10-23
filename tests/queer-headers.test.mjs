import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../profile-metadata.js';

const meta = globalThis.QDPProfileMetadata;
const flags = { artist: 'queerArtist', venue: 'queerVenue', party: 'queerParty', collective: 'queerCollective' };
const archive = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
const generator = fs.readFileSync(new URL('../admin/post-generator.js', import.meta.url), 'utf8');

test('each profile type uses its own approved queer flag', () => {
  for (const [kind, flag] of Object.entries(flags)) {
    assert.equal(meta.isQueer(kind, { [flag]: true }), true, kind);
    assert.equal(meta.isQueer(kind, { [flag]: false }), false, kind);
    assert.equal(meta.isQueer(kind, { transArtist: true }), false, kind);
    const otherFlags = Object.fromEntries(Object.values(flags).map(key => [key, key !== flag]));
    assert.equal(meta.isQueer(kind, otherFlags), false, kind);
    assert.equal(meta.isQueer(kind, null), false, kind);
  }
});

test('client navigation applies purple to queer profiles and clears it for other profiles and directories', () => {
  const start = archive.indexOf('  function setProfile(');
  const end = archive.indexOf('\n  function leave()', start);
  assert.ok(start >= 0 && end > start);
  const classes = new Set();
  const context = vm.createContext({ archive: {}, menuReset: true, clearMenuProfile() {},
    archivePage: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
    window: { QDPProfileMetadata: meta } });
  vm.runInContext(archive.slice(start, end), context);
  for (const [kind, flag] of Object.entries(flags)) {
    context.setProfile(kind, { name: 'Public profile', [flag]: true });
    assert.equal(classes.has('is-queer-profile'), true, kind);
    context.setProfile(kind, { name: 'Public profile', [flag]: false });
    assert.equal(classes.has('is-queer-profile'), false, kind);
  }
  context.setProfile('artist', { queerArtist: true });
  context.setProfile('');
  assert.equal(classes.has('is-queer-profile'), false);
});

test('generated event images paint purple date headers only for ExplicitQueer events', () => {
  const start = generator.indexOf('  function popupDateBox(');
  const end = generator.indexOf('\n  function stripes(', start);
  const popupStart = generator.indexOf('  function popupSlide(');
  const popupEnd = generator.indexOf('\n  async function addImage(', popupStart);
  assert.ok(start >= 0 && end > start && popupStart >= 0 && popupEnd > popupStart);
  const fills = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'fill') return () => fills.push(target.fillStyle);
      return key in target ? target[key] : () => {};
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  const context = vm.createContext({ WIDTH: 1727, HEIGHT: 2048, Q: 17.27, DATE_WIDTH: 750, DATE_HEIGHT: 86.35,
    COLORS: { regularPopup: '#202125', queerPopup: '#290925', text: '#ffeff2', red: '#fa2b5a', queerCard: '#922185' },
    RAINBOW: [], TRANS: [], canvas: () => [{}, ctx], roundedPath() {}, stripes() {},
    dateKey: () => '2030-10-14', posterDate: () => 'Mon, Oct 14th', stripFlags: value => value,
    fitText: canvas => { canvas.font = '40px Verdana'; }, wrapped: (_, value) => value ? [value] : [] });
  vm.runInContext(generator.slice(start, end) + '\n' + generator.slice(popupStart, popupEnd), context);
  const base = { title: 'Public event', start: '2030-10-14T22:00:00-04:00', venue: 'Public room', address: '123 Market St' };
  for (const event of [
    { ...base, explicitQueer: true },
    { ...base, explicitQueer: true, queerArtist: true, transArtist: true },
    { ...base, explicitQueer: false, queerArtist: true, transArtist: true },
    { ...base, explicitQueer: false, partyId: 'MELT-001' },
    base
  ]) {
    fills.length = 0;
    context.popupSlide({}, event, null, null, null);
    const purple = event.explicitQueer === true;
    assert.ok(fills.includes(purple ? '#922185' : '#fa2b5a'));
    assert.equal(fills.includes(purple ? '#fa2b5a' : '#922185'), false);
  }
});
