import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../archive.js', import.meta.url), 'utf8');
const from = source.indexOf('  function updateArtistDrawerCorners()');
const to = source.indexOf('\n  function profileInfo(', from);
assert.ok(from >= 0 && to > from);

function fixture() {
  const state = { clipped: 0, height: 240, radius: 40, present: true };
  const styles = new Map();
  const drawer = { getBoundingClientRect: () => ({ top: 100 - state.clipped, height: state.height }),
    style: { setProperty: (name, value) => styles.set(name, value) } };
  const context = vm.createContext({
    archiveStack: { querySelector: () => state.present ? drawer : null },
    archiveHeader: { getBoundingClientRect: () => ({ bottom: 100 }) },
    getComputedStyle: () => ({ borderTopLeftRadius: `${state.radius}px` })
  });
  vm.runInContext(source.slice(from, to), context);
  return { state, styles, update: () => context.updateArtistDrawerCorners() };
}

test('photo corners follow the calendar midpoint rule and restore when scrolling back', () => {
  const f = fixture();
  for (const [clipped, radius] of [[-20, 40], [0, 40], [60, 40], [120, 40],
    [180, 20], [240, 0], [300, 0], [180, 20], [60, 40], [0, 40]]) {
    f.state.clipped = clipped;
    f.update();
    assert.equal(f.styles.get('--archive-portrait-radius'), `${radius}px`, `clipped ${clipped}px`);
  }
});

test('photo corners use the resized header radius and tolerate missing or unmeasured photos', () => {
  const f = fixture();
  Object.assign(f.state, { height: 120, radius: 20, clipped: 90 });
  f.update();
  assert.equal(f.styles.get('--archive-portrait-radius'), '10px');
  f.state.clipped = 0;
  f.update();
  assert.equal(f.styles.get('--archive-portrait-radius'), '20px');
  f.state.height = 0;
  f.update();
  assert.equal(f.styles.get('--archive-portrait-radius'), '20px');
  f.state.present = false;
  assert.doesNotThrow(f.update);
});
