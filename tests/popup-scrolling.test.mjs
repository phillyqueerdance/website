import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const from = app.indexOf('poster.addEventListener("wheel", event => {');
const to = app.indexOf('\nwindow.addEventListener(\n  "keydown",', from);
assert.ok(from >= 0 && to > from);
const wheelListener = app.slice(from, to);

function fixture(archiveActive, popup = '') {
  let handler;
  const scrolled = [];
  const calendarTarget = {}, archiveTarget = {};
  const stack = (name, target) => ({
    contains: element => element === target,
    scrollBy: options => scrolled.push([name, options.top])
  });
  const archiveStack = stack('archive', archiveTarget);
  vm.runInNewContext(wheelListener, {
    poster: { addEventListener: (type, callback) => {
      assert.equal(type, 'wheel');
      handler = callback;
    } },
    infoView: { active: popup },
    window: { QDPArchive: { active: archiveActive } },
    document: { getElementById: () => archiveStack },
    eventDetail: { hidden: true }, datePopover: { hidden: true },
    eventStack: stack('calendar', calendarTarget), pageCards: [{}]
  });
  return { handler, scrolled, calendarTarget, archiveTarget };
}

function wheel(target = {}) {
  return {
    target, deltaY: 160, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
}

for (const archiveActive of [false, true]) {
  const mode = archiveActive ? 'archive' : 'calendar';
  for (const popup of ['about', 'melt']) {
    test(`${popup} scroll stays native and leaves the ${mode} behind it still`, () => {
      const f = fixture(archiveActive, popup);
      const event = wheel();
      f.handler(event);
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(f.scrolled, []);
    });
  }

  test(`${mode} still scrolls from the poster and keeps native feed scrolling`, () => {
    const f = fixture(archiveActive);
    const posterWheel = wheel();
    f.handler(posterWheel);
    assert.equal(posterWheel.defaultPrevented, true);
    assert.deepEqual(f.scrolled, [[mode, 160]]);

    const feedWheel = wheel(archiveActive ? f.archiveTarget : f.calendarTarget);
    f.handler(feedWheel);
    assert.equal(feedWheel.defaultPrevented, false);
    assert.deepEqual(f.scrolled, [[mode, 160]]);
  });
}
