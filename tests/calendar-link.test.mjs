import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('function googleCalendarEventUrl(event) {');
const end = source.indexOf('\nasync function copyEventLink', start);
assert.ok(start >= 0 && end > start);
const calendarUrl = vm.runInNewContext(
  source.slice(start, end) + '\ngoogleCalendarEventUrl',
  {
    Date, URL,
    eventVenue: event => event.venue,
    eventAddress: event => event.address,
    eventIdOf: event => event.eventId,
    eventPermalink: id => `https://queerdancephilly.com/?event=${id}`,
    displayTitle: event => event.title
  }
);

test('calendar link opens a Google event draft with correct cross-midnight times', () => {
  const url = new URL(calendarUrl({
    eventId: 'QDP1', title: 'Dance & Go',
    start: '2026-10-01T22:00:00-04:00', end: '2026-10-02T02:00:00-04:00',
    venue: 'A Venue', address: '123 Market St', description: 'Doors at 10.'
  }));
  assert.equal(url.origin, 'https://calendar.google.com');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), 'Dance & Go');
  assert.equal(url.searchParams.get('dates'), '20261002T020000Z/20261002T060000Z');
  assert.equal(url.searchParams.get('location'), 'A Venue, 123 Market St');
  assert.equal(url.searchParams.get('stz'), 'America/New_York');
  assert.match(url.searchParams.get('details'), /Doors at 10\.[\s\S]*\?event=QDP1/);
});

test('an event without an end time gets a one-hour calendar draft', () => {
  const url = new URL(calendarUrl({
    eventId: 'QDP2', title: 'Open Decks', start: '2026-10-01T20:00:00-04:00'
  }));
  assert.equal(url.searchParams.get('dates'), '20261002T000000Z/20261002T010000Z');
  assert.equal(url.searchParams.has('location'), false);
});
