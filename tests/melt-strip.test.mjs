import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderEventCard, renderLivePoster } from '../functions/live-poster.js';
import { renderProfileEvents } from '../functions/profile-page.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const generator = fs.readFileSync(new URL('../admin/post-generator.js', import.meta.url), 'utf8');
const createCard = app.slice(app.indexOf('function createEventCard('), app.indexOf('\nfunction renderPoster('));
const drawCard = generator.slice(generator.indexOf('  function eventCard('), generator.indexOf('  function calendarSlide('));
const base = { eventId: 'MELT-NIGHT', title: 'Melt', partyId: 'MELT-001', venue: "Val's Lesbian Bar", address: '605 S. 3rd St.',
  start: '2030-10-14T22:00:00-04:00', explicitQueer: true, queerArtist: true, transArtist: true };

function element(tag) {
  return { tag, className: '', dataset: {}, children: [], attributes: {},
    appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {} };
}

test('browser and server event strips select the same party ID and retain link labels and flags', () => {
  const context = vm.createContext({ document: { createElement: element }, eventIdOf: e => e.eventId,
    eventPermalink: id => `/?event=${id}`, displayTitle: e => e.title, eventVenue: e => e.venue, eventAddress: e => e.address });
  vm.runInContext(createCard, context);
  for (const [partyId, expected] of [['MELT-001', true], [' melt-001 ', true], ['MELT-0012', false], ['', false]]) {
    const event = { ...base, partyId };
    const card = context.createEventCard(event);
    assert.equal(card.className.split(' ').includes('melt'), expected);
    assert.equal(card.href, '/?event=MELT-NIGHT');
    assert.equal(card.children.filter(child => child.className.startsWith('card-flag')).length, 2);
    assert.deepEqual(card.children.find(child => child.className === 'event-card-content').children.map(child => child.textContent),
      [event.title, event.venue, event.address]);
    const markup = renderEventCard(event);
    assert.equal(markup.match(/^<a class="([^"]+)"/)[1].split(' ').includes('melt'), expected);
    assert.match(markup, /card-flag-queer/);
    assert.match(markup, /card-flag-trans/);
    assert.match(markup, /<div class="event-title">Melt<\/div>/);
    assert.match(markup, /aria-hidden="true"><\/span><span class="event-card-content">/);
  }
});

test('initial calendar and current/past profile markup use the branded strip', () => {
  const live = renderLivePoster([base], new Date('2030-10-14T12:00:00Z')).markup;
  assert.match(live, /event-card explicit has-flags melt/);
  assert.match(live, /event-time/);
  const past = { ...base, eventId: 'MELT-OLD', start: '2024-10-14T22:00:00-04:00' };
  const profile = renderProfileEvents('party', { id: 'MELT-001' }, [base, past], 'https://qdp.example', Date.parse('2030-10-01'));
  assert.equal((profile.match(/event-card explicit has-flags melt/g) || []).length, 2);
  assert.match(profile, /event=MELT-NIGHT/);
  assert.match(profile, /event=MELT-OLD/);
});

test('post strip renderer layers the artwork around flags without duplicate lettering', () => {
  const art = { name: 'Melt strip' };
  for (const flags of [[false, false], [true, false], [false, true], [true, true]]) {
    const operations = []; let balance = 0;
    const ctx = { save() { balance++; }, restore() { balance--; }, clip() { operations.push('clip'); },
      fill() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      drawImage(...args) { operations.push(['art', ...args]); }, fillText(text) { operations.push(['text', text]); } };
    const context = vm.createContext({ Q: 17.27, CARD_X: 350, CARD_WIDTH: 1188.176, COLORS: {}, RAINBOW: [], TRANS: [],
      roundedPath() {}, stripes() { operations.push('flag'); }, stripFlags: value => value,
      fitText() { return 20; }, wrapped: (_, value) => value ? [value] : [], ellipsis: (_, value) => value });
    vm.runInContext(drawCard, context);
    context.eventCard(ctx, { ...base, queerArtist: flags[0], transArtist: flags[1] }, 100, 186.516, 0, 1, art);
    const images = operations.filter(value => Array.isArray(value) && value[0] === 'art');
    assert.equal(images.length, flags.some(Boolean) ? 2 : 1);
    images.forEach(args => assert.deepEqual(args.slice(1), [art, 350, 100, 1188.176, 186.516]));
    assert.equal(operations.filter(value => value === 'flag').length, flags.filter(Boolean).length);
    assert.equal(operations.some(value => Array.isArray(value) && value[0] === 'text'), false);
    assert.equal(balance, 0);
    if (flags.some(Boolean)) {
      assert.ok(operations.indexOf(images[0]) < operations.indexOf('flag'));
      assert.ok(operations.lastIndexOf(images.at(-1)) > operations.lastIndexOf('flag'));
    }
    operations.length = 0;
    context.eventCard(ctx, { ...base, partyId: 'OTHER-001', queerArtist: flags[0], transArtist: flags[1] }, 100, 186.516, 0, 1, art);
    assert.equal(operations.some(value => Array.isArray(value) && value[0] === 'art'), false);
    assert.ok(operations.some(value => Array.isArray(value) && value[0] === 'text' && value[1] === 'Melt'));
  }
});

test('the full generation flow loads strip artwork only for selected Melt events and passes it to calendar slides', async () => {
  for (const melt of [true, false]) {
    const assets = [], calendars = [], elements = new Map();
    const element = id => {
      if (!elements.has(id)) elements.set(id, { value: '', listeners: {},
        addEventListener(name, fn) { this.listeners[name] = fn; }, replaceChildren() {} });
      return elements.get(id);
    };
    const instrumented = generator.replace(/\}\)\(\);\s*$/, `
      image = async path => { assets.push(path); return { path }; };
      loadTitleFont = async () => {};
      flyerImage = async () => null;
      titleSlide = popupSlide = () => ({});
      calendarSlide = (frame, days, artwork) => { calendars.push({ days, artwork }); return {}; };
      addImage = async () => {};
    })();`);
    vm.runInNewContext(instrumented, { Intl, Date, AbortController, console, assets, calendars, navigator: {},
      document: { documentElement: {}, getElementById: element }, window: { addEventListener() {} },
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      fetch: async () => ({ ok: true, json: async () => ({ events: [{ ...base, partyId: melt ? 'MELT-001' : 'OTHER-001' }] }) }) });
    element('postStart').value = element('postEnd').value = '2030-10-14';
    await element('postForm').listeners.submit({ preventDefault() {} });
    assert.match(element('postStatus').textContent, /PNG images ready/);
    assert.equal(assets.filter(path => path.includes('melt-event-strip')).length, melt ? 1 : 0);
    assert.equal(Boolean(calendars[0].artwork), melt);
  }
});
