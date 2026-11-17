import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const metadata = readFileSync(new URL("../event-metadata.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../live-calendar.js", import.meta.url), "utf8");
const admin = readFileSync(new URL("../admin/admin.js", import.meta.url), "utf8");
const context = vm.createContext({
  URL,
  Option: class {
    constructor(text, value) {
      this.text = text;
      this.value = value;
    }
  },
  document: {
    getElementById: () => null,
    querySelectorAll: () => [],
    createDocumentFragment() {
      return { children: [], append(option) { this.children.push(option); } };
    }
  }
});
vm.runInContext("globalThis.window = globalThis", context);
vm.runInContext(metadata, context);
vm.runInContext(calendar, context);
vm.runInContext(admin.slice(0, admin.indexOf("\nelements.refreshButton.addEventListener(")), context);

const now = new Date("2026-11-17T14:00:00Z");
const event = (eventId, fields = {}) => ({
  eventId,
  publicTitle: eventId,
  start: "2026-11-17T21:00:00-05:00",
  publishToWeb: true,
  description: "Event description",
  venueId: "VENUE-001",
  ...fields
});
const ids = (views, view) => Array.from(views.get(view), row => row.eventId);

test("legacy flyer data distinguishes missing flyers from unverified listings", () => {
  const events = [
    event("ADMIN-BLANK", { flyerUrl: "" }),
    event("FEED-BLANK"),
    event("FEED-FLYER"),
    event("HIDDEN", { publishToWeb: false }),
    event("ADMIN-FLYER", { flyerUrl: "https://example.com/flyer.jpg" })
  ];
  const feed = new Map([
    ["FEED-BLANK", ""],
    ["FEED-FLYER", "https://example.com/flyer.jpg"],
    ["ADMIN-FLYER", ""]
  ]);
  const { views, unknownFlyers } = context.dashboardEventViews(events, feed, now);
  assert.deepEqual(ids(views, "missing-flyer"), ["ADMIN-BLANK", "FEED-BLANK"]);
  assert.equal(unknownFlyers, 1);
});

test("review queues use saved active rows and flag both sides of a possible duplicate", () => {
  const events = [
    event("ORIGINAL", { publicTitle: "🏳️‍🌈 Late   Show", needsPush: true }),
    event("DUPLICATE", {
      publicTitle: "late show",
      start: "2026-11-18T02:00:00Z",
      publishToWeb: false,
      venueId: "",
      description: " "
    }),
    event("ANOTHER-DATE", { publicTitle: "Late Show", start: "2026-11-18T22:00:00-05:00" }),
    event("REMOVED", { publicTitle: "Late Show", needsPush: true, removedFromSheet: true })
  ];
  const { views } = context.dashboardEventViews(events, new Map(), now);
  assert.deepEqual(ids(views, "possible-duplicate"), ["ORIGINAL", "DUPLICATE"]);
  assert.deepEqual(ids(views, "hidden-upcoming"), ["DUPLICATE"]);
  assert.deepEqual(ids(views, "missing-venue"), ["DUPLICATE"]);
  assert.deepEqual(ids(views, "missing-description"), ["DUPLICATE"]);
  assert.deepEqual(ids(views, "needs-push"), ["ORIGINAL"]);
});

test("duplicate starts can differ by up to three hours within the same QDP night", () => {
  const events = [
    event("LATE", { publicTitle: "Sazón: Late Night", start: "2026-11-17T21:45:00-05:00" }),
    event("AFTER-MIDNIGHT", { publicTitle: "Sazon Late Night", start: "2026-11-18T00:45:00-05:00" }),
    event("TOO-FAR", { publicTitle: "Sazon Late Night", start: "2026-11-18T03:46:00-05:00" }),
    event("BEFORE-CUTOFF", { publicTitle: "Sunrise Dance", start: "2026-11-18T05:30:00-05:00" }),
    event("AFTER-CUTOFF", { publicTitle: "Sunrise Dance", start: "2026-11-18T06:00:00-05:00" })
  ];
  const { views } = context.dashboardEventViews(events, new Map(), now);
  assert.deepEqual(ids(views, "possible-duplicate"), ["LATE", "AFTER-MIDNIGHT"]);

  const overnight = new Date("2026-11-18T01:00:00-05:00");
  const { views: overnightViews } = context.dashboardEventViews(events, new Map(), overnight);
  assert.deepEqual(ids(overnightViews, "possible-duplicate"), ["LATE", "AFTER-MIDNIGHT"]);
});

test("a shared venue allows a typo or extra wording in the title", () => {
  const events = [
    event("ORIGINAL", { publicTitle: "Melt", venueName: "Val’s Lesbian Bar" }),
    event("TYPO", { publicTitle: "Mlet", start: "2026-11-17T23:00:00-05:00" }),
    event("EXTRA-WORDS", {
      publicTitle: "Melt with Callaia",
      start: "2026-11-17T22:00:00-05:00",
      venueId: "",
      venueName: "Vals Lesbian Bar"
    }),
    event("OTHER-VENUE", { publicTitle: "Melt with Friends", venueId: "VENUE-002" }),
    event("DIFFERENT-TITLE", { publicTitle: "Deep House" })
  ];
  const { views } = context.dashboardEventViews(events, new Map(), now);
  assert.deepEqual(ids(views, "possible-duplicate"), ["ORIGINAL", "TYPO", "EXTRA-WORDS"]);
});

test("coverage includes empty dates and counts saved website events by their local start date", () => {
  const overnight = new Date("2026-11-18T03:00:00-05:00");
  const events = [
    event("TONIGHT"),
    event("AFTER-MIDNIGHT", { start: "2026-11-18T02:00:00-05:00" }),
    event("HIDDEN", { publishToWeb: false }),
    event("DELETED", { publicTitle: "(DELETED ENTRY) Deleted Event" }),
    event("REMOVED", { removedFromSheet: true }),
    event("LATER", { start: "2026-12-15T21:00:00-05:00" })
  ];
  const { coverage } = context.dashboardEventViews(events, new Map(), overnight);
  assert.equal(coverage.size, 28);
  assert.deepEqual(ids(coverage, "2026-11-17"), ["TONIGHT"]);
  assert.deepEqual(ids(coverage, "2026-11-18"), ["AFTER-MIDNIGHT"]);
  assert.deepEqual(ids(coverage, "2026-12-14"), []);
  assert.equal(coverage.has("2026-12-15"), false);
});

test("venue choices include Index entries without a public profile", () => {
  const options = context.createVenueOptions([
    { id: "VENUE-001", name: "Test venue", publicOK: true },
    { id: "SECLOC-001", name: "Secret Location", publicOK: false },
    { id: "TOBEAN-001", name: "To Be Announced", publicOK: false }
  ]);
  assert.deepEqual(options.children.map(option => option.value), ["", "VENUE-001", "SECLOC-001", "TOBEAN-001"]);
});

test("Admin uses its current scripts from either dashboard URL", () => {
  const html = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)]
    .map(match => match[1]);
  for (const base of ["https://queerdancephilly.com/admin", "https://queerdancephilly.com/admin/"]) {
    assert.ok(assets.includes("/admin/admin.js?v=20261117-remove-standard"));
    for (const asset of assets) {
      assert.ok(asset.startsWith("/"));
      assert.equal(new URL(asset, base).pathname, asset.split("?")[0]);
    }
  }
});

test("event rows link to QDP listings when the saved event is published", () => {
  const html = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
  assert.match(html, /class="event-view-link" target="_blank" rel="noopener noreferrer" hidden>View event/);
  assert.equal(context.hasWebsiteListing(event("PUBLISHED")), true);
  assert.equal(context.hasWebsiteListing(event("HIDDEN", {publishToWeb: false})), false);
  assert.equal(context.hasWebsiteListing(event("DELETED", {publicTitle: "(DELETED ENTRY)"})), false);
  assert.equal(context.window.QDPEventMetadata.url("EVENT-001"), "https://queerdancephilly.com/?event=EVENT-001");
});

test("external event links prefer the saved URL and accept source posts in descriptions", () => {
  assert.equal(context.externalEventUrl({
    eventUrl: "https://example.com/event",
    description: "https://www.instagram.com/p/SOURCE/"
  }), "https://example.com/event");
  assert.equal(context.externalEventUrl({
    description: '<a href="https://www.instagram.com/p/SOURCE/">Source</a>'
  }), "https://www.instagram.com/p/SOURCE/");
  assert.equal(context.externalEventUrl({
    description: "Tickets https://ra.co/events/1234567."
  }), "https://ra.co/events/1234567");
  assert.equal(context.externalEventUrl({eventUrl: "javascript:alert(1)"}), "");
  assert.equal(context.externalEventUrl({
    description: "https://drive.google.com/file/d/PHOTO/view https://www.instagram.com/dj_example/"
  }), "");
  assert.equal(context.externalEventUrl({eventUrl: "https://queerdancephilly.com/?event=EVENT-001"}), "");
});
