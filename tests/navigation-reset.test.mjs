import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const archive = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
const mobile = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const currentCalendar = between(app, 'async function showCurrentCalendar()', '\ntodayButton.addEventListener(');
const archiveClicks = between(archive, '  document.addEventListener("click",', '\n  window.addEventListener("popstate",');
const menuSource = between(archive, '  function showMenu(', '\n  function hideMenu()') + '\n' +
  between(archive, '  function clearMenuProfile()', '\n  function leave()');
const discoverClick = between(archive, '  discoverLink.addEventListener("click",', '\n  archiveStack.addEventListener(');
const mobileOpen = between(mobile, '  function openDiscover(', '\n  function updateAlphabet()');

function click(target, modifiers = {}) {
  return { target, button: 0, defaultPrevented: false, ...modifiers,
    preventDefault() { this.defaultPrevented = true; } };
}
function calendarFixture({ url = 'https://example.test/', pages, detail = false, info = '' } = {}) {
  const actions = [];
  const location = { href: url, origin: 'https://example.test' };
  let handler;
  const context = { URL, URLSearchParams, Date, location,
    posterPages: pages ?? [{ date: '2026-10-07' }, { date: '2026-10-08' }, { date: '2026-10-17' }],
    eventDetail: { hidden: !detail }, infoView: { active: info },
    window: { QDPArchive: { active: new URL(url).searchParams.has('archive') } },
    history: { pushState(state, title, url) { actions.push(['push', url.href]); location.href = url.href; } },
    dateKey: () => '2026-10-08', requestedEventId: () => new URL(location.href).searchParams.get('event'),
    hideEventDetail(options) { actions.push(['hide-event', options.restoreFocus]); context.eventDetail.hidden = true; },
    closeDatePopover() { actions.push(['close-dates']); },
    scrollToPage(index, behavior) { actions.push(['scroll', index, behavior]); },
    async ensureLiveEvents() {}, hideMenu() { actions.push(['hide-menu']); },
    route() { context.window.QDPArchive.active = false; context.infoView.active = ''; },
    document: { addEventListener(type, fn) { assert.equal(type, 'click'); handler = fn; } }
  };
  vm.createContext(context);
  vm.runInContext(currentCalendar + '\n' + archiveClicks, context);
  const anchor = { href: 'https://example.test/' };
  const target = { closest: () => anchor };
  return { context, actions, handler, target };
}

test('Calendar at the home URL resets a previously selected date without adding history', () => {
  const f = calendarFixture();
  const event = click(f.target);
  f.handler(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.actions, [['hide-menu'], ['close-dates'], ['scroll', 1, 'auto']]);
});

for (const url of ['?archive=artist&id=CALLAIA&event=MELT', '?event=MELT', '#about']) {
  test(`Calendar from ${url} returns to today's feed and closes covered content`, () => {
    const f = calendarFixture({ url: 'https://example.test/' + url, detail: true, info: 'about' });
    f.handler(click(f.target));
    assert.equal(f.context.location.href, 'https://example.test/');
    assert.equal(f.context.window.QDPArchive.active, false);
    assert.equal(f.context.infoView.active, '');
    assert.equal(f.context.eventDetail.hidden, true);
    assert.deepEqual(f.actions.at(-1), ['scroll', 1, 'auto']);
    assert.equal(f.actions.filter(action => action[0] === 'push').length, 1);
  });
}

test('current calendar starts at the next available date when today has no events', async () => {
  const f = calendarFixture({ pages: [{ date: '2026-10-07' }, { date: '2026-10-09' }] });
  await f.context.window.QDPShowCurrentCalendar();
  assert.deepEqual(f.actions.at(-1), ['scroll', 1, 'auto']);
});

test('Calendar waits for a feed opened from a direct profile URL, and respects later navigation', async () => {
  for (const navigateAway of [false, true]) {
    const f = calendarFixture({ pages: [] });
    let finish;
    f.context.ensureLiveEvents = () => new Promise(resolve => { finish = resolve; });
    const pending = f.context.window.QDPShowCurrentCalendar();
    f.context.posterPages = [{ date: '2026-10-08' }];
    f.context.window.QDPArchive.active = navigateAway;
    finish();
    await pending;
    assert.deepEqual(f.actions.filter(action => action[0] === 'scroll'), navigateAway ? [] : [['scroll', 0, 'auto']]);
  }
});

test('modified Calendar clicks retain normal browser navigation', () => {
  const f = calendarFixture();
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    const event = click(f.target, { [modifier]: true });
    f.handler(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(f.actions, []);
});

function element() {
  const attributes = new Map(), classes = new Set();
  return { attributes, classes, hidden: false, scrollTop: 250, children: [], dataset: {},
    classList: { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n) },
    getAttribute: n => attributes.get(n), setAttribute: (n, v) => attributes.set(n, v),
    removeAttribute: n => attributes.delete(n), replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); }, get firstChild() { return this.children[0]; },
    style: { setProperty() {} }, after() {}, offsetHeight: 1 };
}
function menuFixture({ open = true } = {}) {
  const person = { id: 'CALLAIA', name: 'Callaia' };
  const menu = element(), menuProfile = element(), menuTrack = element(), discoverLink = element();
  menu.classes.add('has-profile'); menuProfile.children = ['artist information'];
  discoverLink.setAttribute('aria-expanded', String(open));
  const links = ['artists', 'venues', 'parties', 'collectives', 'events'].map(view => {
    const link = element(); link.href = `https://example.test/?archive=${view}`;
    if (view === 'artists') link.setAttribute('aria-current', 'page');
    return link;
  });
  menu.querySelectorAll = () => links; menu.querySelector = () => links[0];
  const actions = [], frames = [];
  let handler;
  discoverLink.addEventListener = (type, fn) => { assert.equal(type, 'click'); handler = fn; };
  const context = { URL, menu, menuProfile, menuTrack, discoverLink,
    venueMap: element(), alphabet: element(), exitTimer: 0, menuMotionSerial: 0, menuReset: false,
    directoryViews: new Set(['artists', 'venues', 'parties', 'collectives']),
    profileViews: { artist: 'artists', venue: 'venues', party: 'parties', collective: 'collectives' },
    archive: { active: true, profile: { kind: 'artist', person },
      isMenuOpen: () => discoverLink.getAttribute('aria-expanded') === 'true' },
    document: { documentElement: element(), body: element() },
    clearTimeout() {}, requestAnimationFrame: fn => frames.push(fn), positionMenu() {},
    profileInfo: (kind, person) => `${kind}: ${person.name}`,
    getComputedStyle: () => ({ color: 'purple', backgroundColor: 'red' }),
    window: { matchMedia: () => ({ matches: false }), QDPMobile: { active: false } },
    location: { href: 'https://example.test/?archive=artist&id=CALLAIA' }
  };
  vm.createContext(context);
  vm.runInContext(menuSource + '\n' + discoverClick + '\narchive.resetMenu = resetMenu;', context);
  return { context, handler, person, links, frames, actions };
}

for (const open of [true, false]) {
  test(`Discover clears profile details and returns to the main menu when ${open ? 'open' : 'closed'}`, () => {
    const f = menuFixture({ open });
    const url = f.context.location.href;
    f.handler(click());
    f.frames.forEach(fn => fn());
    assert.equal(f.context.menuProfile.hidden, true);
    assert.equal(f.context.menuProfile.children.length, 0);
    assert.equal(f.context.menu.classes.has('has-profile'), false);
    assert.equal(f.context.alphabet.hidden, true);
    assert.equal(f.context.venueMap.hidden, true);
    assert.ok(f.links.every(link => !link.getAttribute('aria-current')));
    assert.equal(f.context.menuTrack.scrollTop, 0);
    assert.equal(f.context.discoverLink.getAttribute('aria-expanded'), 'true');
    assert.equal(f.context.archive.profile.person, f.person);
    assert.equal(f.context.location.href, url);
    vm.runInContext('setProfile("artist", archive.profile.person);', f.context);
    assert.equal(f.context.menuProfile.children.length, 0, 'a pending load or background refresh must not repopulate the reset menu');
    assert.equal(f.context.archive.profile.person, f.person);
  });
}

test('the mobile Discover button clears profile details, while history restoration keeps its menu state', () => {
  const f = menuFixture();
  Object.assign(f.context, {
    media: { matches: true }, returnFocus: null, closeMore() {},
    toggleClass: (el, name, value) => value ? el.classList.add(name) : el.classList.remove(name),
    pushPanel: kind => f.actions.push(['panel', kind]), sync() {},
    discoverClose: { focus() {} }, view: () => 'artist'
  });
  f.context.window.QDPArchive = f.context.archive;
  f.context.archive.showMenu = view => f.actions.push(['restore', view]);
  vm.runInContext(mobileOpen + '\nopenDiscover();', f.context);
  assert.equal(f.context.menuProfile.hidden, true);
  assert.deepEqual(f.actions, [['panel', 'discover']]);
  vm.runInContext('openDiscover({ historyEntry: false, reset: false });', f.context);
  assert.deepEqual(f.actions, [['panel', 'discover'], ['restore', 'artist']]);
});
