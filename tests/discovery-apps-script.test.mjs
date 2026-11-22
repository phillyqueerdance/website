import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { discoveryIdentity } from "../shared/discovery-identity.js";
import { prepareReview } from "../tools/discovery/daily-review.mjs";
import { discoveryFixture } from "./helpers/discovery-script-fixture.mjs";

const fields = { "Title (internal)": "Test night", StartDate: "2026-12-19", EndDate: "2026-12-20",
  StartTime: "21:00", EndTime: "02:00", Location: "Test room", Lineup_Raw: "Test artist", RawFlyerURL: "https://example.invalid/flyer.jpg" };
test("the read-only credential cannot read anything before it is authorized", () => {
  const f = discoveryFixture();
  assert.throws(() => f.feed({ readToken: "b".repeat(64) }), /authorization/);
  assert.equal(f.sheetReads, 0); assert.equal(f.locks, 0);
});
test("Admin Exclude is automatically carried into the next review through a decisions-only snapshot", async () => {
  const f = discoveryFixture(), identity = await discoveryIdentity(fields);
  f.save(identity, "EXCLUDE");
  const page = JSON.parse(JSON.stringify(f.feed()));
  assert.equal(page.complete, true); assert.equal(page.provider, "apps_script");
  assert.equal(JSON.stringify(page).includes("a".repeat(64)), false);
  const s = { intake_headers: ["Title (internal)", ...Array.from({ length: 42 }, (_, i) => "blank" + i)],
    pending_candidates: [{ fields }], daily_discovery: { appsScriptFeedback: { provider: "apps_script", enabled: true } } };
  const result = await prepareReview(s, {}, { ...page, source: "apps_script", lastLiveSyncAt: page.readAt }, "2026-11-22");
  assert.equal(result.rows.length, 0); assert.equal(result.coverage.excluded, 1);
  assert.equal(result.nextState.daily_discovery.decisionReader, "apps_script");
  assert.equal(result.coverage.decisionFeedback.source, "apps_script");
  assert.equal(result.nextState.daily_discovery.decisionReadAt, page.readAt);
  assert.equal(f.tables.size, 1);
});
test("only successful intake creates Include receipts and duplicate retries remain safe", async () => {
  const f = discoveryFixture(), identity = await discoveryIdentity(fields), rows = [{ discovery: identity }];
  assert.throws(() => f.save(identity, "INCLUDE"), /confirmed import/);
  assert.throws(() => f.import(rows, { added: 0, alreadySaved: 0 }), /fully confirmed/);
  assert.equal(f.records().length, 0);
  f.import(rows, { added: 1, alreadySaved: 0 });
  f.import(rows, { added: 0, alreadySaved: 1 });
  assert.equal(f.read(identity).decision, "INCLUDE");
  assert.equal(f.records().length, identity.aliases.length);
});
test("Wait restores an excluded edition but leaves other editions and new corrections independent", async () => {
  const f = discoveryFixture(), id = await discoveryIdentity(fields);
  f.save(id, "EXCLUDE"); f.save(id, "WAIT");
  assert.equal(f.read(id).decision, "WAIT");
  const next = await discoveryIdentity({ ...fields, StartDate: "2027-02-20" });
  assert.equal(f.read(next), null);
  f.save(id, "INCLUDE", true);
  const correction = await discoveryIdentity(fields, "correction", "new poster");
  assert.equal(f.read(correction), null);
  f.save(correction, "INCLUDE", true);
  assert.equal(f.read(correction).decision, "INCLUDE");
  assert.equal(f.read(await discoveryIdentity(fields, "correction", "later poster")), null);
});
test("a malformed decision batch is rejected before any ledger write", async () => {
  const f = discoveryFixture(), identity = await discoveryIdentity(fields);
  assert.throws(() => f.context.qdpDiscoverySave_([
    { identity, decision: "WAIT" }, { identity: { ...identity, id: "invalid" }, decision: "EXCLUDE" }
  ], false), /invalid/);
  assert.equal(f.sheetWrites, 0);
});
test("pagination has a stable revision and detects writes between pages", async () => {
  const f = discoveryFixture(); f.context.qdpSetupDiscoveryFeedback();
  const sheet = f.tables.get("QDP_Discovery_Decisions");
  sheet.rows.push(...Array.from({ length: 1001 }, (_, i) => {
    const id = (i + 1).toString(16).padStart(64, "0");
    return [id, id, "event", "2026-12-19", "WAIT", "2026-11-22T12:00:00Z"];
  }));
  const first = f.feed(); assert.equal(first.records.length, 1000); assert.equal(first.complete, false);
  const second = f.feed({ cursor: first.cursor }); assert.equal(second.records.length, 1); assert.equal(second.complete, true);
  assert.equal(first.revision, second.revision);
  sheet.rows[1][4] = "EXCLUDE";
  assert.throws(() => f.feed({ cursor: first.cursor }), /changed during pagination/);
});
test("the legacy hosted feed is retired without touching any remote store", async () => {
  const { onRequestGet } = await import("../functions/api/discovery-decisions.js");
  const response = onRequestGet({ env: new Proxy({}, { get() { throw new Error("No account storage access"); } }) });
  assert.equal(response.status, 410);
});
test("the Admin route delegates decision storage to Apps Script and never requests a KV binding", async () => {
  const source = fs.readFileSync(new URL("../functions/admin/discovery-decisions.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const identity = await discoveryIdentity(fields), requests = [];
  const c = vm.createContext({ Response, URL, TextEncoder, verifyAccess: async () => {}, validateIdentity: value => value,
    requestAppsScriptAdmin: async (env, body) => { requests.push(body); return { ok: "yes", feedbackVersion: 1, records: [{ decision: "EXCLUDE" }] }; } });
  vm.runInContext(source, c);
  const request = new Request("https://qdp.example/admin/discovery-decisions", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://qdp.example" },
    body: JSON.stringify({ operation: "save", items: [{ identity, decision: "EXCLUDE" }] }) });
  const response = await c.onRequestPost({ request, env: new Proxy({}, { get() { throw new Error("No KV bindings"); } }) });
  assert.equal(response.status, 200);
  assert.equal(requests[0].action, "admin.discovery.decisions");
});

test("full Core dispatch keeps the read token separate from Admin writes and records receipts server-side", async t => {
  if (!process.env.QDP_CORE_SOURCE) return t.skip("Set QDP_CORE_SOURCE to the full replacement Core.gs");
  const f = discoveryFixture({ coreSource: fs.readFileSync(process.env.QDP_CORE_SOURCE, "utf8") }), c = f.context;
  c.ContentService = { MimeType: { JSON: "json" }, createTextOutput: text => ({ text, setMimeType() { return this; } }) };
  const secretProperty = vm.runInContext("CONFIG.ADMIN_SHARED_SECRET_PROPERTY", c);
  f.props.set(secretProperty, "fixture-admin-secret");
  const post = body => JSON.parse(c.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const identity = await discoveryIdentity(fields);
  assert.equal(post({ action: "admin.discovery.decisions", operation: "save", items: [{ identity, decision: "EXCLUDE" }], readToken: "a".repeat(64) }).ok, "no");
  assert.equal(f.records().length, 0);
  const saved = post({ action: "admin.discovery.decisions", adminToken: "fixture-admin-secret", operation: "save", items: [{ identity, decision: "EXCLUDE" }] });
  assert.equal(saved.ok, "yes");
  const snapshot = post({ action: "discovery.feedback.read", readToken: "a".repeat(64), sheet: "Events", operation: "save" });
  assert.equal(snapshot.records[0].decision, "EXCLUDE");
  assert.equal(snapshot.provider, "apps_script");
  c.qdpAdminImportWithRules_ = () => ({ added: 1, alreadySaved: 0 });
  const imported = post({ action: "admin.apifyimport", adminToken: "fixture-admin-secret", rows: [{ discovery: identity }] });
  assert.equal(imported.feedbackVersion, 1);
  assert.equal(f.read(identity).decision, "INCLUDE");
});
