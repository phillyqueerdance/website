import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../admin/post-generator.js', import.meta.url), 'utf8');

async function generate(events, first = '2030-10-09', last = '2030-10-10') {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      replaceChildren() {} });
    return elements.get(id);
  };
  const images = [];
  // Exercise the real submit handler and pagination; substitute only drawing,
  // asset loading, and file export so the test needs no browser or network.
  const instrumented = source.replace(/\}\)\(\);\s*$/, `
    image = async () => ({});
    loadTitleFont = async () => {};
    flyerImage = async () => ({});
    titleSlide = () => ({ type: 'title' });
    calendarSlide = (_, days) => ({ type: 'calendar', days });
    popupSlide = (_, event) => ({ type: 'event', event });
    addImage = async (slide, caption, filename) => images.push({ slide, caption, filename });
  })();`);
  assert.notEqual(instrumented, source);
  vm.runInNewContext(instrumented, {
    Intl, Date, console, images, navigator: {},
    document: { documentElement: {}, getElementById: element },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ events }) })
  });
  element('postStart').value = first;
  element('postEnd').value = last;
  await element('postForm').listeners.submit({ preventDefault() {} });
  assert.match(element('postStatus').textContent, /PNG images ready\./);
  assert.equal(element('generatePost').disabled, false);
  return JSON.parse(JSON.stringify(images));
}

const calendarIds = images => images.filter(item => item.slide.type === 'calendar')
  .flatMap(item => item.slide.days.flatMap(day => day.events.map(event => event.eventId)));
const individualIds = images => images.filter(item => item.slide.type === 'event')
  .map(item => item.slide.event.eventId);

test('generated individual slides follow all flag priorities while calendars retain chronology', async () => {
  const events = [
    ['non-none', false, false, false], ['non-queer', false, true, false],
    ['non-trans', false, false, true], ['non-both', false, true, true],
    ['queer-none', true, false, false], ['queer-queer', true, true, false],
    ['queer-trans', true, false, true], ['queer-both', true, true, true]
  ].map(([eventId, explicitQueer, queerArtist, transArtist], index) => ({
    eventId, title: eventId, start: `2030-10-09T${14 + index}:00:00-04:00`,
    explicitQueer, queerArtist, transArtist
  }));
  const before = structuredClone(events);
  const images = await generate(events);
  assert.deepEqual(individualIds(images), [
    'queer-both', 'queer-trans', 'queer-queer', 'queer-none',
    'non-both', 'non-trans', 'non-queer', 'non-none'
  ]);
  assert.deepEqual(calendarIds(images), events.map(event => event.eventId));
  assert.deepEqual(images.slice(0, 3).map(item => item.slide.type), ['title', 'calendar', 'calendar']);
  assert.ok(images.slice(3).every(item => item.slide.type === 'event'));
  assert.deepEqual(images.slice(3).map(item => item.filename),
    Array.from({ length: 8 }, (_, index) => `qdp-2030-10-09-2030-10-10-event-0${index + 1}.png`));
  assert.deepEqual(events, before, 'the source feed must not be reordered or changed');
});

test('equal priorities retain date, time, and alphabetical ordering; missing flags rank last', async () => {
  const events = [
    { eventId: 'later', title: 'First alphabetically', start: '2030-10-10T12:00:00-04:00' },
    { eventId: 'beta', title: 'beta', start: '2030-10-09T20:00:00-04:00' },
    { eventId: 'alpha', title: 'Alpha', start: '2030-10-09T20:00:00-04:00' }
  ].map(event => ({ ...event, explicitQueer: true, queerArtist: true, transArtist: true }));
  events.push({ eventId: 'unflagged', title: 'Unflagged', start: '2030-10-09T13:00:00-04:00' });
  events.push({ eventId: 'outside', title: 'Outside dates', start: '2030-10-11T13:00:00-04:00' });
  events.push({ eventId: 'deleted', title: '(DELETED ENTRY) removed', start: '2030-10-09T14:00:00-04:00' });
  const images = await generate(events);
  assert.deepEqual(individualIds(images), ['alpha', 'beta', 'later', 'unflagged']);
  assert.deepEqual(calendarIds(images), ['unflagged', 'alpha', 'beta', 'later']);
});

test('posts exceeding 20 images retain calendar dates and packing while individual slides are prioritized', async () => {
  const events = Array.from({ length: 22 }, (_, index) => ({
    eventId: `E${index}`, title: `Event ${index}`,
    start: `2030-10-${String(9 + (index < 18 ? Math.floor(index / 6) : 3 + Math.floor((index - 18) / 2))).padStart(2, '0')}T${14 + (index < 18 ? index % 6 : index % 2)}:00:00-04:00`,
    explicitQueer: index % 2 === 1, queerArtist: index % 3 === 0, transArtist: index % 4 === 0
  }));
  const images = await generate(events, '2030-10-09', '2030-10-13');
  assert.equal(images.length, 27);
  assert.deepEqual(calendarIds(images), events.map(event => event.eventId));
  assert.deepEqual(images.filter(item => item.slide.type === 'calendar')
    .map(item => item.slide.days.map(day => day.key)),
  [['2030-10-09'], ['2030-10-10'], ['2030-10-11'], ['2030-10-12', '2030-10-13']]);
  assert.equal(individualIds(images).length, events.length);
  assert.ok(images.slice(5, 16).every(item => item.slide.event.explicitQueer));
});
