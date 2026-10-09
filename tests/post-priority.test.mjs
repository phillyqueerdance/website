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

function assertPageSequence(images, expectedGroups) {
  assert.equal(images[0].slide.type, 'title');
  let offset = 1;
  for (const ids of expectedGroups) {
    assert.equal(images[offset++].slide.type, 'calendar');
    for (const id of ids) {
      const { slide } = images[offset++];
      assert.equal(slide.type, 'event');
      assert.equal(slide.event.eventId, id);
    }
  }
  assert.equal(offset, images.length, 'every image belongs to its expected calendar group');
}

test('each calendar page is followed by its own prioritized events, covering all flag combinations', async () => {
  const events = [
    ['non-none', false, false, false], ['queer-queer', true, true, false],
    ['non-trans', false, false, true], ['queer-both', true, true, true],
    ['queer-none', true, false, false], ['non-queer', false, true, false],
    ['queer-trans', true, false, true], ['non-both', false, true, true]
  ].map(([eventId, explicitQueer, queerArtist, transArtist], index) => ({
    eventId, title: eventId, start: `2030-10-09T${14 + index}:00:00-04:00`,
    explicitQueer, queerArtist, transArtist
  }));
  const before = structuredClone(events);
  const images = await generate(events);
  assertPageSequence(images, [
    ['queer-both', 'queer-queer', 'non-trans', 'non-none'],
    ['queer-trans', 'queer-none', 'non-both', 'non-queer']
  ]);
  assert.deepEqual(calendarIds(images), events.map(event => event.eventId));
  assert.deepEqual(images.filter(item => item.slide.type === 'event').map(item => item.filename),
    Array.from({ length: 8 }, (_, index) => `qdp-2030-10-09-2030-10-10-event-0${index + 1}.png`));
  assert.deepEqual(events, before, 'the source feed must not be reordered or changed');
});

test('calendar dates take precedence; equal priorities retain time and alphabetical ordering', async () => {
  const events = [
    { eventId: 'later', title: 'First alphabetically', start: '2030-10-10T12:00:00-04:00' },
    { eventId: 'beta', title: 'beta', start: '2030-10-09T20:00:00-04:00' },
    { eventId: 'alpha', title: 'Alpha', start: '2030-10-09T20:00:00-04:00' }
  ].map(event => ({ ...event, explicitQueer: true, queerArtist: true, transArtist: true }));
  events.push({ eventId: 'unflagged', title: 'Unflagged', start: '2030-10-09T13:00:00-04:00' });
  events.push({ eventId: 'outside', title: 'Outside dates', start: '2030-10-11T13:00:00-04:00' });
  events.push({ eventId: 'deleted', title: '(DELETED ENTRY) removed', start: '2030-10-09T14:00:00-04:00' });
  const images = await generate(events);
  assertPageSequence(images, [['alpha', 'beta', 'unflagged'], ['later']]);
  assert.deepEqual(calendarIds(images), ['unflagged', 'alpha', 'beta', 'later']);
});

test('posts exceeding 20 images retain calendar packing and prioritize events within each page', async () => {
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
  assertPageSequence(images, [
    ['E3', 'E1', 'E5', 'E0', 'E4', 'E2'],
    ['E9', 'E7', 'E11', 'E8', 'E6', 'E10'],
    ['E15', 'E13', 'E17', 'E12', 'E16', 'E14'],
    ['E21', 'E19', 'E20', 'E18']
  ]);
});

test('combined 13th and 14th calendar is followed by its events before the 15th calendar', async () => {
  const events = [
    { eventId: '13-unflagged', title: '13 unflagged', start: '2030-10-13T14:00:00-04:00' },
    { eventId: '13-trans', title: '13 trans', start: '2030-10-13T15:00:00-04:00', explicitQueer: true, transArtist: true },
    { eventId: '14-both', title: '14 both', start: '2030-10-14T14:00:00-04:00', explicitQueer: true, queerArtist: true, transArtist: true },
    { eventId: '14-queer', title: '14 queer', start: '2030-10-14T15:00:00-04:00', queerArtist: true }
  ];
  // A busy 15th triggers the existing >20-image packing rule and splits that
  // day across pages. All of its events outrank some events on the earlier page.
  const laterIds = Array.from({ length: 19 }, (_, index) => `15-${index}`);
  events.push(...laterIds.map((eventId, index) => ({
    eventId, title: eventId, start: `2030-10-15T12:${String(index).padStart(2, '0')}:00-04:00`,
    explicitQueer: true, queerArtist: true, transArtist: true
  })));
  const images = await generate(events, '2030-10-13', '2030-10-15');
  assert.deepEqual(images.filter(item => item.slide.type === 'calendar')
    .map(item => item.slide.days.map(day => day.key)),
  [['2030-10-13', '2030-10-14'], ['2030-10-15'], ['2030-10-15'], ['2030-10-15'], ['2030-10-15']]);
  assertPageSequence(images, [
    ['14-both', '13-trans', '14-queer', '13-unflagged'],
    laterIds.slice(0, 5), laterIds.slice(5, 10), laterIds.slice(10, 15), laterIds.slice(15)
  ]);
  assert.deepEqual(calendarIds(images), events.map(event => event.eventId));
  assert.deepEqual(individualIds(images).sort(), events.map(event => event.eventId).sort(),
    'each selected event is rendered exactly once');
});
