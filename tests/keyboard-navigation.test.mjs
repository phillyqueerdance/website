import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const mobile = fs.readFileSync(new URL('../mobile.js', import.meta.url), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

const movePoster = between(app, 'function movePoster(direction) {', '\npreviousPoster.addEventListener(');
const desktopKeys = between(app, 'window.addEventListener(\n  "keydown",', '\nposter.addEventListener(\n  "touchstart",');
const mobileKeys = between(mobile, 'document.addEventListener("keydown",', '\n  window.addEventListener("popstate",');

function key(name, modifiers = {}) {
  return {
    key: name, defaultPrevented: false, propagationStopped: false,
    ...modifiers,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagationStopped = true; }
  };
}

function keyboard(mode) {
  const actions = [];
  let handler;
  const context = {
    window: {
      QDPArchive: { active: mode.startsWith('archive'), move: direction => actions.push(['archive', direction]) },
      addEventListener: (type, callback) => { assert.equal(type, 'keydown'); handler = callback; }
    },
    infoView: { active: '', close: () => actions.push(['close-info']) },
    eventDetail: { hidden: !mode.endsWith('event') },
    closeEventDetail: () => actions.push(['close-event']),
    closeDatePopover() {},
    moveEventDetail: direction => actions.push(['event', direction]),
    scrollToPage: index => actions.push(['calendar', index]),
    navigationTargetIndex: null, currentPosterIndex: 1, posterPages: [{}, {}, {}]
  };
  vm.runInNewContext(movePoster + '\n' + desktopKeys, context);
  return { handler, actions, context };
}

for (const mode of ['calendar', 'archive', 'event', 'archive-event']) {
  test(`modified arrows leave browser shortcuts intact on ${mode}`, () => {
    const f = keyboard(mode);
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
      for (const direction of ['ArrowLeft', 'ArrowRight']) {
        const event = key(direction, { [modifier]: true });
        f.handler(event);
        assert.equal(event.defaultPrevented, false, `${modifier} ${direction}`);
        assert.deepEqual(f.actions, []);
      }
    }
  });

  test(`plain arrows still navigate ${mode}`, () => {
    const f = keyboard(mode);
    const left = key('ArrowLeft'), right = key('ArrowRight');
    f.handler(left); f.handler(right);
    assert.equal(left.defaultPrevented, true);
    assert.equal(right.defaultPrevented, true);
    const expected = mode.endsWith('event') ? 'event' : mode;
    assert.deepEqual(f.actions, expected === 'calendar'
      ? [['calendar', 0], ['calendar', 2]] : [[expected, -1], [expected, 1]]);
  });
}

test('already handled arrows are respected and Escape still closes the current view', () => {
  const f = keyboard('event');
  f.handler(key('ArrowLeft', { defaultPrevented: true }));
  assert.deepEqual(f.actions, []);
  f.handler(key('Escape'));
  assert.deepEqual(f.actions, [['close-event']]);
  f.context.infoView.active = 'about';
  f.handler(key('Escape'));
  assert.deepEqual(f.actions, [['close-event'], ['close-info']]);
});

test('mobile menu capture leaves modified arrows intact and retains its focus trap', () => {
  let handler;
  const focused = [];
  const controls = [0, 1].map(id => ({ getClientRects: () => [{}], focus: () => focused.push(id) }));
  const root = { querySelectorAll: () => controls, contains: () => false };
  vm.runInNewContext(mobileKeys, {
    document: { activeElement: null, addEventListener: (type, callback) => { assert.equal(type, 'keydown'); handler = callback; } },
    media: { matches: true }, discoverOpen: () => true, track: root,
    nav: { classList: { contains: () => false } }, moreLinks: root
  });
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    for (const direction of ['ArrowLeft', 'ArrowRight']) {
      const event = key(direction, { [modifier]: true });
      handler(event);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
    }
  }
  const plain = key('ArrowLeft');
  handler(plain);
  assert.equal(plain.propagationStopped, true);
  const shiftTab = key('Tab', { shiftKey: true });
  handler(shiftTab);
  assert.equal(shiftTab.defaultPrevented, true);
  assert.deepEqual(focused, [1]);
});
