import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const metadata = readFileSync(new URL("../event-metadata.js", import.meta.url), "utf8");
const admin = readFileSync(new URL("../admin/admin.js", import.meta.url), "utf8");
const context = vm.createContext({
  URL,
  document: { getElementById: () => null, querySelectorAll: () => [] }
});
vm.runInContext("globalThis.window = globalThis", context);
vm.runInContext(metadata, context);
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

test("the week includes ongoing events and ends at the Philadelphia date boundary", () => {
  const events = [
    event("OVERNIGHT", { start: "2026-11-16T22:00:00-05:00", end: "2026-11-17T15:00:00Z" }),
    event("ENDED", { start: "2026-11-17T05:00:00-05:00", end: "2026-11-17T13:00:00Z" }),
    event("LAST-NIGHT", { start: "2026-11-24T04:59:00Z" }),
    event("NEXT-WEEK", { start: "2026-11-24T05:00:00Z" })
  ];
  const { views } = context.dashboardEventViews(events, new Map(), now);
  assert.deepEqual(ids(views, "next-seven-days"), ["OVERNIGHT", "LAST-NIGHT"]);
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
