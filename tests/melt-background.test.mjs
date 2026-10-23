import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderEventPage } from '../functions/event-page.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const generator = fs.readFileSync(new URL('../admin/post-generator.js', import.meta.url), 'utf8');
const openStart = app.indexOf('function openEventDetail(');
const themeSetup = app.slice(openStart, app.indexOf('  const dateBadge =', openStart)) + '}';
const popup = generator.slice(generator.indexOf('  function popupSlide('), generator.indexOf('  async function addImage('));
const base = { eventId: 'NIGHT-1', title: 'Melt', start: '2030-10-14T22:00:00-04:00', venue: 'The Room', address: '123 Market St' };
const cases = [
  { label: 'linked Melt', partyId: 'MELT-001', explicitQueer: true, melt: true },
  { label: 'linked Melt without explicit flag', partyId: 'MELT-001', explicitQueer: false, melt: true },
  { label: 'normalized party ID', partyId: ' melt-001 ', explicitQueer: true, melt: true },
  { label: 'similar ID', partyId: 'MELT-0012', explicitQueer: true, melt: false },
  { label: 'Melt title without the party ID', partyId: '', explicitQueer: false, melt: false },
  { label: 'another queer party', partyId: 'OTHER-001', explicitQueer: true, melt: false }
];

test('browser popup switches Melt backgrounds by party ID and clears it for the next event', () => {
  const classes = new Set();
  const context = vm.createContext({
    closeDatePopover() {}, eventIdOf: event => event.eventId,
    document: { activeElement: null }, window: {},
    eventStack: { scrollTop: 0, querySelectorAll: () => [] },
    eventDetail: { hidden: true, classList: {
      add: value => classes.add(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
    } }
  });
  vm.runInContext(themeSetup, context);
  for (const item of cases) {
    context.openEventDetail({ ...base, ...item }, { updateHistory: false });
    assert.equal(classes.has('melt'), item.melt, item.label);
    assert.equal(classes.has('explicit'), item.explicitQueer, item.label);
  }
});

test('direct event pages have the same Melt theme before browser JavaScript runs', () => {
  const previous = globalThis.HTMLRewriter;
  let classes;
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) handler.element({
        setAttribute(name, value) { if (selector === '#eventDetail' && name === 'class') classes = value; },
        setInnerContent() {}, removeAttribute() {}, remove() {}, append() {}
      });
      return response;
    }
  };
  try {
    for (const item of cases) {
      const event = { ...base, ...item };
      renderEventPage({ request: new Request('https://qdp.example/?event=NIGHT-1'), env: {} },
        new Response('<html></html>'), { status: 200, event }, event.eventId);
      assert.equal(classes.split(' ').includes('melt'), item.melt, item.label);
      assert.equal(classes.split(' ').includes('explicit'), item.explicitQueer, item.label);
    }
    renderEventPage({ request: new Request('https://qdp.example/?event=MISSING'), env: {} },
      new Response('<html></html>'), { status: 404, error: 'Unavailable' }, 'MISSING');
    assert.equal(classes.split(' ').includes('melt'), false);
  } finally { globalThis.HTMLRewriter = previous; }
});

test('generated event slides draw Melt art ahead of the standard queer background', () => {
  const frame = { name: 'frame' }, queer = { name: 'queer' }, melt = { name: 'melt' };
  const drawings = [];
  const ctx = new Proxy({}, {
    get(target, key) { return key in target ? target[key] : key === 'drawImage' ? (...args) => drawings.push(args) : () => {}; },
    set(target, key, value) { target[key] = value; return true; }
  });
  const context = vm.createContext({ WIDTH: 1727, HEIGHT: 2048, Q: 17.27, DATE_HEIGHT: 86.35,
    COLORS: { regularPopup: '#202125', queerPopup: '#290925', text: '#ffeff2' },
    RAINBOW: [], TRANS: [], canvas: () => [{}, ctx], roundedPath() {}, stripes() {}, popupDateBox() {},
    dateKey: () => '2030-10-14', stripFlags: value => value,
    fitText: ctx => { ctx.font = '40px Verdana'; }, wrapped: (_, value) => value ? [value] : [] });
  vm.runInContext(popup, context);
  for (const item of cases) {
    drawings.length = 0;
    context.popupSlide(frame, { ...base, ...item, queerArtist: true, transArtist: true }, null, queer, melt);
    const expected = item.melt ? melt : item.explicitQueer ? queer : null;
    assert.deepEqual(drawings.map(args => args[0]), expected ? [frame, expected] : [frame], item.label);
  }
});

test('generation loads Melt artwork only when the selected events need it and passes it to the slide', async () => {
  for (const linked of [true, false]) {
    const elements = new Map(), assets = [], rendered = [];
    const element = id => {
      if (!elements.has(id)) elements.set(id, { value: '', listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; }, replaceChildren() {} });
      return elements.get(id);
    };
    const source = generator.replace(/\}\)\(\);\s*$/, `
      image = async path => { assets.push(path); return { path }; };
      loadTitleFont = async () => {};
      flyerImage = async () => null;
      titleSlide = calendarSlide = () => ({});
      popupSlide = (_, event, flyer, queer, melt) => { rendered.push({ event, melt }); return {}; };
      addImage = async () => {};
    })();`);
    vm.runInNewContext(source, { Intl, Date, AbortController, console, assets, rendered, navigator: {},
      window: { addEventListener() {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
      document: { documentElement: {}, getElementById: element },
      fetch: async () => ({ ok: true, json: async () => ({ events: [{ ...base, partyId: linked ? 'MELT-001' : 'OTHER-001' }] }) }) });
    element('postStart').value = element('postEnd').value = '2030-10-14';
    await element('postForm').listeners.submit({ preventDefault() {} });
    assert.match(element('postStatus').textContent, /PNG images ready/);
    assert.equal(assets.filter(path => path.includes('melt-popup-background')).length, linked ? 1 : 0);
    assert.equal(Boolean(rendered[0].melt), linked);
  }
});
