import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../live-calendar.js';
import { onRequestGet as eventsApi } from '../functions/api/events.js';
import { onRequestGet as homePage } from '../functions/index.js';
import { renderLivePoster } from '../functions/live-poster.js';

const calendar = globalThis.QDPLiveCalendar;
const event = (eventId, start, end) => ({ eventId, title: eventId, start, end });
const sunday = event('SUNDAY', '2026-10-18T21:00:00-04:00', '2026-10-19T02:00:00-04:00');
const late = event('LATE', sunday.start, '2026-10-19T08:00:00-04:00');
const monday = event('MONDAY', '2026-10-19T21:00:00-04:00');
const listings = [sunday, late, monday];
const at = time => Date.parse(time);
const ids = events => events.map(event => event.eventId);

test('Sunday listings roll off at exactly 6 a.m. Monday, independent of their sheet presence', () => {
  assert.equal(calendar.dayKey(at('2026-10-19T05:59:59-04:00')), '2026-10-18');
  assert.equal(calendar.dayKey(at('2026-10-19T06:00:00-04:00')), '2026-10-19');
  assert.equal(calendar.isVisible(sunday, at('2026-10-19T05:59:59-04:00')), true);
  assert.equal(calendar.isVisible(sunday, at('2026-10-19T06:00:00-04:00')), false);
  assert.equal(calendar.isVisible(sunday, at('2026-10-19T15:00:00-04:00')), false);
  assert.equal(calendar.isVisible(monday, at('2026-10-19T15:00:00-04:00')), true);
});

test('events running after 6 a.m. remain until their actual end; malformed end times use the cutoff', () => {
  assert.equal(calendar.isVisible(late, at('2026-10-19T06:00:00-04:00')), true);
  assert.equal(calendar.isVisible(late, at('2026-10-19T07:59:59-04:00')), true);
  assert.equal(calendar.isVisible(late, at('2026-10-19T08:00:00-04:00')), false);
  for (const end of [undefined, 'invalid', '2026-10-18T20:00:00-04:00']) {
    assert.equal(calendar.expiresAt({ ...sunday, end }), at('2026-10-19T06:00:00-04:00'));
  }
  assert.equal(calendar.isVisible({ start: 'invalid' }), false);
  assert.equal(calendar.isVisible(null), false);
});

test('the cutoff stays at local 6 a.m. across both daylight-saving transitions and year changes', () => {
  for (const [start, cutoff] of [
    ['2026-03-07T21:00:00-05:00', '2026-03-08T06:00:00-04:00'],
    ['2026-10-31T21:00:00-04:00', '2026-11-01T06:00:00-05:00'],
    ['2026-12-31T21:00:00-05:00', '2027-01-01T06:00:00-05:00']
  ]) {
    assert.equal(calendar.expiresAt(event('NIGHT', start)), at(cutoff));
    assert.equal(calendar.isVisible(event('NIGHT', start), at(cutoff) - 1), true);
    assert.equal(calendar.isVisible(event('NIGHT', start), at(cutoff)), false);
  }
});

test('server-rendered cards obey the cutoff and label a remaining overnight event with its start date', () => {
  const result = renderLivePoster(listings, new Date('2026-10-19T06:00:00-04:00'));
  assert.doesNotMatch(result.markup, /data-event-id="SUNDAY"/);
  assert.match(result.markup, /data-event-id="LATE"/);
  assert.match(result.markup, /data-event-id="MONDAY"/);
  assert.equal(result.dateLabel, 'Sunday, October 18th');
});

test('prepared and fallback APIs filter the same way, and cached responses cannot cross the cutoff or late end', async () => {
  const previousNow = Date.now, previousCaches = globalThis.caches, previousFetch = globalThis.fetch;
  let now = at('2026-10-19T05:59:59-04:00');
  Date.now = () => now;
  try {
    for (const prepared of [true, false]) {
      const edge = new Map();
      globalThis.caches = { default: {
        match: async key => edge.get(key.url)?.clone() ?? null,
        put: async (key, value) => edge.set(key.url, value.clone())
      } };
      globalThis.fetch = async () => Response.json({ events: listings });
      const context = { request: new Request('https://qdp.example/api/events'),
        env: prepared ? { QDP_PUBLIC_FEED_KV: { get: async () => ({ schema: 1,
          publishedAt: new Date(now).toISOString(), payload: { events: listings } }) } } : {} };
      now = at('2026-10-19T05:59:59-04:00');
      const before = await eventsApi(context);
      assert.deepEqual(ids((await before.json()).events), ['SUNDAY', 'LATE', 'MONDAY']);
      assert.ok(Number(before.headers.get('X-QDP-Cache-Until')) <= at('2026-10-19T06:00:00-04:00'));
      now = at('2026-10-19T06:00:00-04:00');
      assert.deepEqual(ids((await (await eventsApi(context)).json()).events), ['LATE', 'MONDAY']);
      now = at('2026-10-19T07:59:59-04:00');
      const lastSecond = await eventsApi(context);
      assert.ok(Number(lastSecond.headers.get('X-QDP-Cache-Until')) <= at('2026-10-19T08:00:00-04:00'));
      now = at('2026-10-19T08:00:00-04:00');
      assert.deepEqual(ids((await (await eventsApi(context)).json()).events), ['MONDAY']);
    }
  } finally { Date.now = previousNow; globalThis.caches = previousCaches; globalThis.fetch = previousFetch; }
});

test('the homepage cache expires at 6 a.m. and removes old listings from both cards and the embedded feed', async () => {
  const previousNow = Date.now, previousCaches = globalThis.caches, previousRewriter = globalThis.HTMLRewriter;
  let now = at('2026-10-19T05:59:59-04:00');
  Date.now = () => now;
  const edge = new Map(), contents = new Map();
  globalThis.caches = { default: {
    match: async key => edge.get(key.url)?.clone() ?? null,
    put: async (key, value) => edge.set(key.url, value.clone())
  } };
  globalThis.HTMLRewriter = class {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      for (const [selector, handler] of this.handlers) handler.element({ setInnerContent(value) { contents.set(selector, value); } });
      return response;
    }
  };
  const context = { request: new Request('https://qdp.example/'), env: {
    ASSETS: { fetch: async () => new Response('<html></html>') },
    QDP_PUBLIC_FEED_KV: { get: async () => ({ schema: 1, publishedAt: new Date(now).toISOString(), payload: { events: listings } }) }
  } };
  try {
    const before = await homePage(context);
    assert.ok(Number(before.headers.get('X-QDP-Cache-Until')) <= at('2026-10-19T06:00:00-04:00'));
    assert.match(contents.get('#eventStack'), /data-event-id="SUNDAY"/);
    now = at('2026-10-19T06:00:00-04:00');
    await homePage(context);
    assert.doesNotMatch(contents.get('#eventStack'), /data-event-id="SUNDAY"/);
    assert.deepEqual(ids(JSON.parse(contents.get('#qdpInitialEvents')).events), ['LATE', 'MONDAY']);
  } finally { Date.now = previousNow; globalThis.caches = previousCaches; globalThis.HTMLRewriter = previousRewriter; }
});

test('an open browser removes expired saved listings on time even when no network request succeeds', () => {
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const normalize = app.slice(app.indexOf('function normalizePublicEvents('), app.indexOf('\nfunction readCachedPublicEvents('));
  const timer = app.slice(app.indexOf('let displayedPublicEvents ='), app.indexOf('\nfunction refreshPublicEvents('));
  let now = at('2026-10-19T05:59:59-04:00'), callback, delay;
  const rendered = [], saved = [];
  const context = vm.createContext({ liveCalendar: calendar, Date: { now: () => now }, seedEvents: listings,
    eventIdOf: event => event.eventId, stripQdpFooter: value => value,
    renderEventCollection: events => rendered.push(ids(events)), writeCachedPublicEvents: events => saved.push(ids(events)),
    clearTimeout() {}, setTimeout(fn, ms) { callback = fn; delay = ms; return 1; } });
  vm.runInContext(normalize + '\n' + timer + '\ndisplayedPublicEvents = seedEvents; schedulePublicEventExpiry();', context);
  assert.equal(delay, 1000);
  now = at('2026-10-19T06:00:00-04:00');
  callback();
  assert.equal(JSON.stringify(rendered.at(-1)), JSON.stringify(['LATE', 'MONDAY']));
  assert.equal(JSON.stringify(saved.at(-1)), JSON.stringify(['LATE', 'MONDAY']));
  assert.equal(delay, 2 * 60 * 60 * 1000);
  now = at('2026-10-19T08:00:00-04:00');
  callback();
  assert.equal(JSON.stringify(rendered.at(-1)), JSON.stringify(['MONDAY']));
});
