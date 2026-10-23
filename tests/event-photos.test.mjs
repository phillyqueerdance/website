import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { publicEvent, onRequestGet as archiveApi } from '../functions/api/archive.js';
import { onRequestGet as eventApi } from '../functions/api/event.js';
import { shard } from '../functions/event-records.js';
import { renderEventDetail } from '../functions/event-page.js';
import { renderProfileEvents } from '../functions/profile-page.js';
import { renderEventCard, renderLivePoster } from '../functions/live-poster.js';

const photos = globalThis.QDPEventPhotos;
const event = { eventId: 'PHOTO-1', public: true, title: 'A <night> & more',
  start: '2026-09-19T21:00:00-04:00', end: '2026-09-20T01:30:00-04:00',
  artistIds: ['BRENT-001'], explicitQueer: true,
  photoUrls: ['https://example.com/one.jpg', 'https://drive.google.com/file/d/TWO_ID/view'] };

test('one cell preserves photo order, ignores blanks/duplicates, and rejects unsafe links', () => {
  assert.deepEqual(photos.parse(' https://example.com/one.jpg\r\n\nhttps://example.com/two.jpg\nhttps://example.com/one.jpg\njavascript:alert(1)\ndata:image/png;base64,abc\nhttps://user:pass@example.com/private.jpg'),
    ['https://example.com/one.jpg', 'https://example.com/two.jpg']);
  assert.deepEqual(photos.urls({ PhotoURLs: 'https://example.com/a,b.jpg\nhttps://example.com/c.jpg' }),
    ['https://example.com/a,b.jpg', 'https://example.com/c.jpg']);
  assert.deepEqual(photos.parse(null), []);
  assert.deepEqual(photos.parse([{}, 123, 'ftp://example.com/a.jpg']), []);
});

const publisherSources = [['reference publisher', fs.readFileSync(new URL('../apps-script/archive-feed.gs', import.meta.url), 'utf8')]];
if (process.env.QDP_PUBLIC_DATA_FILE) publisherSources.push(['PublicData.gs', fs.readFileSync(process.env.QDP_PUBLIC_DATA_FILE, 'utf8')]);
for (const [label, source] of publisherSources) {
  test(`${label}: publishes optional PhotoURLs by header name on approved current and archived events`, () => {
    const context = vm.createContext({ Map, Set, Date, Object, String, Array, JSON, RegExp,
      CONFIG: { SHEET_EVENTS: 'Events' }, trim: value => String(value ?? '').trim(),
      qdpPublicDateTime_: date => `${date}T21:00:00-04:00`,
      stripAllQdpMetadata_: value => value, extractFlyerUrl_: () => '' });
    vm.runInContext(source, context);
    context.qdpPublicDateTime_ = date => `${date}T21:00:00-04:00`;
    context.qdpPublicEventFacts_ = () => ({ artistIds: ['BRENT-001'], collectiveIds: [], queerArtist: true });
    context.qdpPublicEventTitle_ = title => title;
    const headers = ['PhotoURLs', 'StartDate', 'EventID', 'Publish_To_Web', 'Title'];
    const index = context.qdpArchiveIndex_(headers);
    const row = ['https://example.com/one.jpg\n\nhttps://example.com/two.jpg\nhttps://example.com/one.jpg\njavascript:alert(1)',
      '2026-09-19', 'PHOTO-1', 'Yes', 'A night'];
    for (const tab of ['Events', 'Events_Archive']) {
      const result = context.qdpArchivePublicEvent_(row, index, tab,
        new Map([['BRENT-001', {}]]), new Map(), new Map(), new Map(), new Map());
      assert.deepEqual(Array.from(result.photoUrls), ['https://example.com/one.jpg', 'https://example.com/two.jpg']);
      const missing = context.qdpArchivePublicEvent_(row, { ...index, photourls: undefined }, tab,
        new Map(), new Map(), new Map(), new Map(), new Map());
      assert.deepEqual(Array.from(missing.photoUrls), []);
    }
    row[3] = 'No';
    assert.equal(context.qdpArchivePublicEvent_(row, index, 'Events', new Map(), new Map(), new Map(), new Map(), new Map()), null);
  });
}

test('public APIs retain photos on the same event across Brent, another artist, and direct event lookup', async () => {
  const raw = { ...event, artistIds: ['BRENT-001', 'DJ-001'],
    photoUrls: [...event.photoUrls, 'javascript:alert(1)'] };
  const manifest = { schema: 1, revision: 'photos', artists: raw.artistIds,
    eventIndexVersion: 1, eventShards: 8, eventIds: ['PHOTO-1'], venues: [] };
  const records = new Map([['qdp-archive:v1:manifest', manifest],
    [`qdp-archive:v1:event:${shard('PHOTO-1', 8)}`, { revision: 'photos', entries: { 'PHOTO-1': raw } }]]);
  for (const id of raw.artistIds) {
    const key = `qdp-archive:v1:artist:${shard(id, 4)}`;
    const record = records.get(key) || { revision: 'photos', entries: {} };
    record.entries[id] = { profile: { id, name: id, publicOk: true }, events: [raw] };
    records.set(key, record);
  }
  const context = path => ({ request: new Request(`https://photos.example${path}`),
    env: { QDP_ARCHIVE_KV: { get: async key => records.get(key) || null } } });
  for (const id of raw.artistIds) {
    const response = await archiveApi(context(`/api/archive?resource=artist&id=${id}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).events[0].photoUrls, event.photoUrls);
  }
  const response = await eventApi(context('/api/event?event=PHOTO-1'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).event.photoUrls, event.photoUrls);
  assert.equal(publicEvent({ ...raw, public: false }), null);
  assert.equal(publicEvent({ ...raw, status: 'Cancelled' }), null);
});

test('every event detail shows safe photos in order, with Drive conversion and lazy thumbnails', () => {
  const html = renderEventDetail(event, 'https://photos.example/?event=PHOTO-1');
  assert.match(html, /aria-label="Event photos"/);
  assert.ok(html.indexOf('one.jpg') < html.indexOf('TWO_ID=w1600'));
  assert.match(html, /loading="lazy" decoding="async"/);
  assert.match(html, /Photo 1 from A &lt;night&gt; &amp; more/);
  assert.doesNotMatch(renderEventDetail({ ...event, photoUrls: [] }, 'https://photos.example/'), /event-photo-carousel/);
  assert.equal((html.match(/class="event-photo"/g) || []).length, 2);
  assert.equal((html.match(/aria-label="View Photo [^"]*" hidden/g) || []).length, 1);
  assert.match(html, /aria-label="Previous photo"/);
  assert.match(html, /aria-label="Next photo"/);
});

test('photo strips expand on every profile type and retain the correct Go to event destination', () => {
  for (const [kind, id] of [['artist', 'BRENT-001'], ['artist', 'CALLAIA-001'], ['venue', 'ROOM'], ['party', 'MELT-001'], ['collective', 'CREW']]) {
    const html = renderProfileEvents(kind, { id }, [event], 'https://photos.example');
    assert.equal((html.match(/<details /g) || []).length, 1);
    assert.match(html, /<summary class="event-card /);
    assert.doesNotMatch(html.match(/<summary[^>]*>/)[0], /href=/);
    assert.ok(html.includes(`class="event-photo-go" href="https://photos.example/?archive=${kind}&amp;id=${id}&amp;event=PHOTO-1">Go to event`));
    assert.match(html, /2 photos/);
    assert.match(html, /event-photo-dropdown/);
  }
  assert.doesNotMatch(renderProfileEvents('artist', { id: 'BRENT-001' }, [{ ...event, photoUrls: [] }], 'https://photos.example'), /<details/);
});

test('calendar strips use the same expanding gallery and ordinary events retain their direct links', () => {
  assert.match(renderEventCard(event), /<details class="event-photo-strip/);
  assert.match(renderEventCard(event), /class="event-photo-go" href="\/\?event=PHOTO-1"/);
  assert.match(renderLivePoster([event], new Date('2026-09-19T12:00:00-04:00')).markup, /<details class="event-photo-strip/);
  assert.match(renderEventCard({ ...event, photoUrls: [] }), /^<a class="event-card/);
});

test('the inline carousel shows exactly one photo and wraps forwards and backwards', () => {
  const slides = [{ hidden: false }, { hidden: true }, { hidden: true }].map(slide => ({ ...slide, querySelector: () => null }));
  const counter = { textContent: '1 / 3' };
  const section = { dataset: { photoIndex: '0' }, querySelectorAll: () => slides, querySelector: () => counter };
  for (const [direction, expected] of [[1, 1], [1, 2], [1, 0], [-1, 2], [-1, 1], [-1, 0]]) {
    photos.moveGallery(section, direction);
    assert.equal(section.dataset.photoIndex, String(expected));
    assert.equal(slides.filter(slide => !slide.hidden).length, 1);
    assert.equal(slides[expected].hidden, false);
    assert.equal(counter.textContent, `${expected + 1} / 3`);
  }
});

test('switching photos starts loading immediately and keeps the previous frame until the new image has dimensions', () => {
  const frame = { aspect: 2 / 3, style: { setProperty(name, value) { frame.aspect = value; } } };
  const slides = [false, true].map(hidden => ({ hidden, querySelector() { return this.image; } }));
  slides.forEach(slide => { slide.image = { naturalWidth: 0, naturalHeight: 0, loading: 'lazy',
    closest: selector => selector === '.event-photo' ? slide : frame }; });
  const section = { dataset: { photoIndex: '0' }, querySelectorAll: () => slides, querySelector: () => ({}) };
  photos.moveGallery(section, 1);
  assert.equal(slides[1].image.loading, 'eager');
  assert.equal(frame.aspect, 2 / 3);
  Object.assign(slides[0].image, { naturalWidth: 1600, naturalHeight: 900 });
  photos.moveGallery(section, -1);
  assert.equal(frame.aspect, 1600 / 900);
});

test('browser Go to event opens the intended event and stops the click before the outside-click closer', () => {
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function createEventCard('), app.indexOf('\nfunction renderPoster('));
  let handler, opened, templateMarkup;
  const details = { querySelector: () => ({ addEventListener: (name, fn) => { handler = fn; } }) };
  const template = { content: { firstElementChild: details }, set innerHTML(value) { templateMarkup = value; } };
  const element = tag => tag === 'template' ? template : { className: '', dataset: {}, children: [],
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    setAttribute() {}, addEventListener() {}, get outerHTML() { return `<a class="${this.className}" href="${this.href}"></a>`; } };
  const context = vm.createContext({ QDPEventPhotos: photos, document: { createElement: element },
    eventIdOf: e => e.eventId, eventPermalink: id => `/?archive=party&id=MELT-001&event=${id}`,
    displayTitle: e => e.title, eventVenue: () => '', eventAddress: () => '', openEventDetail: e => { opened = e; } });
  vm.runInContext(source, context);
  assert.equal(context.createEventCard(event), details);
  assert.match(templateMarkup, /archive=party&amp;id=MELT-001&amp;event=PHOTO-1/);
  let prevented = false, stopped = false;
  handler({ button: 0, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(opened, event);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  opened = null;
  handler({ button: 0, metaKey: true });
  assert.equal(opened, null);
});

test('photo viewer moves through the gallery and Escape closes only the viewer and restores its trigger', () => {
  const handlers = new Map();
  const control = () => ({ hidden: false, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
  const image = { removeAttribute(name) { delete this[name]; } }, caption = {};
  const previous = control(), next = control(), close = control();
  const dialog = { handlers: {}, open: false, addEventListener(name, fn) { this.handlers[name] = fn; },
    setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { return selector === 'img' ? image : selector === 'span' ? caption
      : selector.includes('Previous') ? previous : selector.includes('Next') ? next : close; } };
  const grid = { querySelectorAll: () => links };
  const links = event.photoUrls.map((href, index) => ({ href, focused: false,
    closest: selector => selector === '.event-photo-slides' ? grid : selector === 'a[data-event-photo]' ? links[index] : null,
    querySelector: () => ({ alt: `Photo ${index + 1}` }), focus() { this.focused = true; } }));
  const context = vm.createContext({ URL, Object, String, Array, Set, HTMLDialogElement: class {},
    document: { addEventListener: (name, handler) => handlers.set(name, handler),
      createElement: () => dialog, body: { appendChild() {} } } });
  vm.runInContext(fs.readFileSync(new URL('../event-photos.js', import.meta.url), 'utf8'), context);
  let prevented = 0, stopped = 0;
  handlers.get('click')({ target: links[0], button: 0, preventDefault() { prevented++; } });
  assert.equal(dialog.open, true);
  assert.equal(image.src, links[0].href);
  next.handlers.click();
  assert.equal(image.src, links[1].href);
  assert.equal(caption.textContent, '2 / 2');
  dialog.handlers.keydown({ key: 'Escape', preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.equal(dialog.open, false);
  assert.equal(image.src, undefined);
  assert.equal(links[0].focused, true);
  assert.equal(stopped, 1);
  assert.equal(prevented, 2);
});
