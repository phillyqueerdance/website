import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderEventCard } from '../functions/live-poster.js';
import { renderEventDetail, renderEventPage } from '../functions/event-page.js';
import { renderProfileInfo } from '../functions/profile-page.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const archive = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const syncSource = between(app, 'function syncViewAccessibility()', '\npreviousPoster.disabled');
const infoSource = between(app, 'const infoView = {', '\nwindow.QDPInfoView =');
const trapSource = between(app, 'eventDialog.addEventListener("keydown",', '\neventDetail.addEventListener(\n  "click",');

function fixture({ detail = false, profile = false } = {}) {
  const elements = new Map(), callbacks = [], classes = new Set();
  const document = { body: { classList: { contains: n => classes.has(n), add: n => classes.add(n), remove: n => classes.delete(n) } },
    getElementById: id => elements.get(id), querySelector: id => elements.get(id), activeElement: null };
  function element(id) {
    const attributes = new Map();
    const item = { id, hidden: false, inert: false, style: {}, isConnected: true,
      classList: { add() {}, remove() {} }, offsetHeight: 1,
      getAttribute: key => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
      closest: () => item.inert || item.hidden ? item : null,
      focus() { document.activeElement = item; }, getClientRects: () => item.hidden ? [] : [{}],
      addEventListener(type, listener) { callbacks.push([type, listener]); }
    };
    elements.set(id, item); return item;
  }
  for (const id of ['dateButton', 'datePopover', 'eventStack', 'todayButton', 'archiveViewport', '.frame', '.poster-controls',
    'infoViewport', 'eventDialog', 'eventDetail', 'aboutDialogTitle', 'meltDialogTitle', 'archiveHeader', 'aboutLink']) element(id);
  const aboutDialog = element('aboutDialog'), meltDialog = element('meltDialog');
  const eventDetail = elements.get('eventDetail'); eventDetail.hidden = !detail;
  const trigger = elements.get('aboutLink'); document.activeElement = trigger;
  const actions = [];
  const context = { document, eventDetail, eventDialog: elements.get('eventDialog'),
    dateButton: elements.get('dateButton'), datePopover: elements.get('datePopover'),
    eventStack: elements.get('eventStack'), todayButton: elements.get('todayButton'),
    infoViews: { about: aboutDialog, melt: meltDialog }, infoViewport: elements.get('infoViewport'),
    infoExitTimer: 0, activeEvent: detail ? { eventId: 'MELT' } : null, closeDatePopover() {},
    history: { state: null, pushState(state) { this.state = state; }, replaceState() {}, back() { actions.push('back'); } },
    location: { href: 'https://example.test/?archive=artist&id=CALLAIA' }, URL, URLSearchParams,
    requestAnimationFrame: fn => fn(), clearTimeout() {}, setTimeout: fn => { fn(); return 1; },
    window: { QDPArchive: { active: profile, isMenuOpen: () => true, hideMenu() {}, showMenu() {},
      restoreMetadata() { actions.push('profile-metadata'); } },
      QDPEventLinks: { apply() { actions.push('event-metadata'); } } }
  };
  vm.createContext(context);
  vm.runInContext(syncSource + '\n' + infoSource + '\nthis.views = infoView;', context);
  return { context, elements, document, actions, trigger, callbacks };
}

for (const kind of ['about', 'melt']) {
  for (const profile of [false, true]) {
    test(`${kind} from ${profile ? 'profile' : 'calendar'} focuses content, excludes covered listings, and restores its trigger`, () => {
      const f = fixture({ profile });
      f.context.views.show(kind, { historyEntry: false });
      assert.equal(f.document.activeElement.id, `${kind}DialogTitle`);
      assert.equal(f.elements.get('archiveViewport').inert, true);
      assert.equal(f.elements.get('eventStack').inert, true);
      assert.equal(f.elements.get('.poster-controls').inert, true);
      assert.equal(f.elements.get('infoViewport').inert, false);
      f.context.views.close({ historyEntry: false });
      assert.equal(f.document.activeElement, f.trigger);
      assert.equal(f.elements.get('archiveViewport').inert, false);
      assert.equal(f.elements.get('infoViewport').inert, true);
      if (profile) assert.ok(f.actions.includes('profile-metadata'));
    });
  }
}

test('information over an event suspends the dialog, then restores its focus and metadata', () => {
  const f = fixture({ detail: true });
  f.context.syncViewAccessibility();
  assert.equal(f.elements.get('eventDialog').getAttribute('aria-modal'), 'true');
  f.context.views.show('about', { historyEntry: false });
  assert.equal(f.elements.get('eventDialog').getAttribute('role'), null);
  assert.equal(f.elements.get('eventDetail').inert, true);
  f.context.views.close({ historyEntry: false });
  assert.equal(f.document.activeElement.id, 'eventDetail');
  assert.equal(f.elements.get('eventDialog').getAttribute('role'), 'dialog');
  assert.equal(f.elements.get('archiveViewport').inert, true);
  assert.ok(f.actions.includes('event-metadata'));
});

test('closing through browser history waits for the history transition to restore focus', () => {
  const f = fixture(); f.context.views.show('about');
  f.context.views.close();
  assert.deepEqual(f.actions, ['back']);
  assert.equal(f.document.activeElement.id, 'aboutDialogTitle');
  f.context.views.close({ historyEntry: false });
  assert.equal(f.document.activeElement, f.trigger);
});

test('a removed trigger restores focus to the stable profile heading', () => {
  const f = fixture({ profile: true }); f.context.views.show('melt', { historyEntry: false });
  f.trigger.isConnected = false; f.context.views.close({ historyEntry: false });
  assert.equal(f.document.activeElement.id, 'archiveHeader');
});

test('the dialog cycle includes Back and arrows, skips covered controls, and wraps both ways', () => {
  const f = fixture({ detail: true }); f.context.syncViewAccessibility();
  const names = ['aboutLink', 'dateButton', 'archiveHeader'];
  const controls = names.map(id => f.elements.get(id));
  controls[1].hidden = true;
  f.elements.get('eventDialog').querySelectorAll = () => controls;
  vm.runInContext(trapSource, f.context);
  const handler = f.callbacks.find(([type]) => type === 'keydown')[1];
  const key = shiftKey => ({ key: 'Tab', shiftKey, prevented: false, preventDefault() { this.prevented = true; } });
  f.document.activeElement = controls[2]; const forward = key(false); handler(forward);
  assert.equal(forward.prevented, true); assert.equal(f.document.activeElement, controls[0]);
  const backward = key(true); handler(backward);
  assert.equal(backward.prevented, true); assert.equal(f.document.activeElement, controls[2]);
  f.context.views.show('about', { historyEntry: false }); const ordinary = key(false); handler(ordinary);
  assert.equal(ordinary.prevented, false);
});

test('public classifications come only from their corresponding consented flags', () => {
  const meta = globalThis.QDPProfileMetadata;
  for (const [kind, flag] of [['artist','queerArtist'],['venue','queerVenue'],['party','queerParty'],['collective','queerCollective']]) {
    assert.equal(meta.classification(kind, { name: 'Queer name', bio: 'trans queer', [flag]: false }), '');
    assert.equal(meta.classification(kind, { [flag]: true }), `Queer ${kind}.`);
  }
  assert.equal(meta.classification('artist', { transArtist: true }), 'Trans artist.');
  assert.equal(meta.classification('collective', { transArtist: true, queerParty: true }), '');
  assert.match(renderProfileInfo('collective', { name: 'Organization', queerCollective: true }, 'https://example.test'), /sr-only">Queer collective\./);
});

test('initial event HTML exposes the same classification as the hydrated event', () => {
  const event = { eventId: 'PUBLIC', title: 'Dance', start: '2026-10-17T21:00:00-04:00', explicitQueer: true };
  assert.match(renderEventCard(event), /sr-only">Queer event\./);
  assert.match(renderEventDetail(event, 'https://example.test/?event=PUBLIC'), /sr-only">Queer event\./);
  assert.doesNotMatch(renderEventCard({ ...event, explicitQueer: false }), /Queer event\./);
});

test('server-rendered event scope includes a real contextual Back control and excludes covered content', () => {
  const handlers = new Map(), changes = new Map(), previous = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = class {
    on(selector, handler) { handlers.set(selector, handler); return this; }
    transform(page) {
      for (const [selector, handler] of handlers) {
        const attrs = new Map(); changes.set(selector, attrs);
        handler.element({ setAttribute: (k,v) => attrs.set(k,v), removeAttribute: k => attrs.set(k,null),
          setInnerContent: text => attrs.set('content',text) });
      }
      return page;
    }
  };
  try {
    renderEventPage({ request: new Request('https://example.test/?archive=artist&id=CALLAIA&event=MELT'), env: {} },
      new Response('<html></html>'), { status: 404, error: 'Unavailable' }, 'MELT');
    assert.equal(changes.get('#eventDialog').get('role'), 'dialog');
    assert.equal(changes.get('#mobileBack').get('href'), 'https://example.test/?archive=artist&id=CALLAIA');
    assert.equal(changes.get('#mobileBack').get('hidden'), null);
    assert.equal(changes.get('#dateButton, #datePopover, #archiveViewport, #todayButton, .frame').get('inert'), '');
  } finally { globalThis.HTMLRewriter = previous; }
});

test('Discover sizes stay within the viewport as space and label lengths change', () => {
  const positionSource = between(archive, '  function positionMenu() {', '\n  function showMenu(');
  for (const [viewport, left, sideWidth, labelWidth] of [[1363,1009,228,110],[900,685,228,110],[2000,1150,300,160],[800,655,228,260]]) {
    const styles = new Map();
    const menuTrack = { hidden: false, style: { setProperty: (k,v) => styles.set(k,parseFloat(v)) }, getBoundingClientRect: () => ({ left }) };
    const labels = [{ textContent: 'Collectives' }];
    const context = { window: { innerWidth: viewport }, menuTrack,
      menu: { offsetTop: 60, offsetHeight: 360, querySelectorAll: () => labels },
      getComputedStyle: element => ({ fontSize: '18px', rowGap: '10px', width: `${sideWidth}px`, font: '700 18px Fraunces' }),
      document: { getElementById: () => ({ querySelector: () => ({}) }),
        querySelector: selector => selector === '.poster' ? { getBoundingClientRect: () => ({ width: 780, height: 925 }) } : {},
        createElement: () => ({ getContext: () => ({ measureText: () => ({ width: labelWidth }) }) }) }
    };
    vm.runInNewContext(positionSource + '\npositionMenu();', context);
    const inset = styles.get('--archive-menu-inset'), expanded = styles.get('--archive-nav-expanded-width');
    assert.ok(left + inset + expanded <= viewport - 20 + .001);
    assert.ok(styles.get('--archive-tab-length') <= inset + expanded - 12 + .001);
    assert.ok(styles.get('--archive-nav-compact-width') <= expanded);
  }
});
