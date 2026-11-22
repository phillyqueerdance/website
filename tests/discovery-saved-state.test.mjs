import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { discoveryIdentity } from "../shared/discovery-identity.js";
import { prepareReview } from "../tools/discovery/daily-review.mjs";
import { decisionRecords, mergeDecisionRecords, useSavedDecisionState } from "../tools/discovery/saved-decisions.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fields = (extra = {}) => ({ "Title (internal)": "Test night", StartDate: "2026-12-19", EndDate: "2026-12-20",
  StartTime: "21:00:00", EndTime: "01:30:00", Location: "Test room", Lineup_Raw: "Test artist",
  RawFlyerURL: "https://example.invalid/flyer.jpg", Event_URL: "https://www.instagram.com/p/TestOnly/", ...extra });
const state = () => ({ actor: "sones/instagram-posts-scraper-lowcost", usernames: ["test_only"],
  last_completed_collection_at: "2026-11-20T13:00:00Z",
  intake_headers: ["Title (internal)", "StartDate", "EndDate", "StartTime", "EndTime", "Location", "Lineup_Raw",
    "Review", "ImportSourceKey", "ImportSourceSnapshot", ...Array.from({ length: 33 }, (_, i) => "blank" + i)],
  run_history: [{ status: "blocked_before_collection_feedback_unavailable" }],
  pending_candidates: [{ fields: fields() }],
  daily_discovery: { decisionReader: "cloudflare_account_api", decisionFeed: { url: "https://example.invalid", token: "TEST SECRET" },
    decisionStore: { provider: "cloudflare_kv", accountId: "TEST" }, decisionReadAt: "2026-11-20T12:00:00Z" }
});
const choice = async (decision, date = "2026-11-21T12:00:00Z", f = fields()) => ({
  ...await discoveryIdentity(f), decision, updatedAt: date
});

test("a review with legacy Cloudflare settings reads and saves entirely from local state", async () => {
  const s = state();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network access is forbidden in decision preparation"); };
  try {
    const result = await prepareReview(s, { publicComparison: "Fixture only" }, undefined, "2026-11-22");
    assert.equal(calls, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.headers.length, 43);
    assert.equal(result.nextState.daily_discovery.decisionReader, "saved_state");
    assert.equal(result.nextState.daily_discovery.feedbackPolicy.requireLiveFeedback, false);
    assert.equal(result.nextState.daily_discovery.decisionFeed, undefined);
    assert.equal(result.nextState.daily_discovery.decisionStore, undefined);
    assert.equal(result.nextState.daily_discovery.retiredDecisionConfiguration.disabled, true);
    assert.equal(result.nextState.daily_discovery.retiredDecisionConfiguration.decisionFeed.token, "TEST SECRET");
    assert.equal(result.nextState.daily_discovery.decisionReadAt, s.daily_discovery.decisionReadAt);
    assert.deepEqual(result.nextState.run_history, s.run_history);
    assert.equal(result.coverage.decisionFeedback.source, "saved_state");
    assert.equal(result.coverage.decisionFeedback.records, 0);
    assert.match(result.coverage.decisionFeedback.liveAdminFeedback, /Not synced/);
    assert.equal(JSON.stringify(result.coverage).includes("TEST SECRET"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("omitted and empty new feedback both preserve saved exclusions and confirmed receipts", async () => {
  for (const input of [undefined, []]) {
    const s = state();
    s.daily_discovery.decisions = [await choice("EXCLUDE")];
    const result = await prepareReview(s, {}, input, "2026-11-22");
    assert.equal(result.rows.length, 0);
    assert.equal(result.coverage.excluded, 1);
    assert.ok(result.nextState.daily_discovery.decisions.every(d => d.decision === "EXCLUDE"));
  }
  const s = state(); s.daily_discovery.decisions = [await choice("INCLUDE")];
  const result = await prepareReview(s, {}, undefined, "2026-11-22");
  assert.equal(result.rows.length, 0);
  assert.equal(result.coverage.includedOrAlreadyListed, 1);
});

test("a local decision save survives JSON write/read and the following review", async () => {
  const first = await prepareReview(state(), {}, { records: [await choice("EXCLUDE")] }, "2026-11-22");
  const reloaded = JSON.parse(JSON.stringify(first.nextState));
  const second = await prepareReview(reloaded, {}, undefined, "2026-11-23");
  assert.equal(second.rows.length, 0);
  assert.equal(second.coverage.excluded, 1);
  assert.equal(second.nextState.daily_discovery.decisionReadAt, state().daily_discovery.decisionReadAt);
});

test("a partial export preserves other choices and a newer Wait restores a saved excluded item", async () => {
  const s = state();
  const other = fields({ "Title (internal)": "Other night", Event_URL: "https://www.instagram.com/p/OtherTestOnly/" });
  s.pending_candidates.push({ fields: other });
  const excluded = await prepareReview(s, {}, [await choice("EXCLUDE"), await choice("EXCLUDE", undefined, other)], "2026-11-22");
  assert.equal(excluded.rows.length, 0);
  assert.equal(excluded.nextState.daily_discovery.excludedCandidates.length, 2);
  const restored = await prepareReview(excluded.nextState, {}, [await choice("WAIT", "2026-11-22T13:00:00Z")], "2026-11-23");
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.coverage.excluded, 1);
  assert.equal(restored.rows[0][0], "Test night");
});

test("older supplied records cannot overwrite newer saved choices, including timezone offsets", async () => {
  const newer = await choice("EXCLUDE", "2026-11-22T08:00:00-05:00");
  const older = await choice("WAIT", "2026-11-22T12:30:00Z");
  const merged = mergeDecisionRecords([newer], [older]);
  assert.ok(merged.every(d => d.decision === "EXCLUDE"));
});

test("saved correction receipts retire one proposal rather than later source evidence", async () => {
  const s = state(); s.pending_candidates = [];
  const proposal = { Date: "2026-12-19", "Current title": "Test night", Venue: "Test room",
    Correction: "Proposed lineup: Test artist", "Instagram source": fields().Event_URL };
  const initial = await prepareReview(s, { corrections: [proposal] }, undefined, "2026-11-22");
  const text = JSON.stringify([proposal.Correction, "", "", "", "", "", ""]);
  const id = await discoveryIdentity(fields(), "correction", text);
  const saved = await prepareReview(initial.nextState, {}, [{ ...id, decision: "INCLUDE", updatedAt: "2026-11-22T13:00:00Z" }], "2026-11-22");
  assert.equal(saved.corrections.length, 0);
  const next = await prepareReview(saved.nextState, { corrections: [{ ...proposal,
    "Instagram source": "https://www.instagram.com/p/NewTestOnly/", Correction: "Proposed lineup: Another test artist" }] }, undefined, "2026-11-23");
  assert.equal(next.corrections.length, 1);
});

test("malformed saved decisions stop a destructive rewrite rather than silently erasing history", async () => {
  for (const records of [null, { wrong: "shape" }, [{ id: "broken" }]]) {
    const s = state(); s.daily_discovery.decisions = records;
    await assert.rejects(prepareReview(s, {}, undefined, "2026-11-22"), /saved decision|Saved decision/);
    assert.deepEqual(s.daily_discovery.decisions, records);
  }
});

test("a newer event Wait restores a saved correction after that edition was excluded", async () => {
  const s = state(); s.pending_candidates = [];
  const proposal = { Date: "2026-12-19", "Current title": "Test night", Venue: "Test room",
    Correction: "Proposed lineup: Test artist", "Instagram source": fields().Event_URL };
  const excluded = await prepareReview(s, { corrections: [proposal] }, [await choice("EXCLUDE")], "2026-11-22");
  assert.equal(excluded.corrections.length, 0);
  assert.equal(excluded.nextState.daily_discovery.excludedCorrections.length, 1);
  const next = await prepareReview(excluded.nextState, {}, [await choice("WAIT", "2026-11-22T15:00:00Z")], "2026-11-23");
  assert.equal(next.corrections.length, 1);
});

test("legacy metadata snapshots remain readable without connecting to their former store", async () => {
  const record = await choice("EXCLUDE");
  const result = decisionRecords({ result: [{ name: "qdp-discovery-decision:v1:" + record.id, metadata: record }] });
  assert.equal(result[0].alias, record.id);
  assert.equal(result[0].decision, "EXCLUDE");
});

test("configuration migration is repeatable and preserves unrelated data", () => {
  const s = state(); s.private_history = { preserved: true };
  const next = useSavedDecisionState(s);
  assert.deepEqual(useSavedDecisionState(next), next);
  assert.deepEqual(next.private_history, s.private_history);
  assert.deepEqual(next.run_history, s.run_history);
});

test("the documented CLI reads decisions, prepares a review and saves next state with no live feedback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qdp-saved-decisions-"));
  try {
    const s = state();
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(s));
    await fs.writeFile(path.join(dir, "review.json"), JSON.stringify({ candidates: [], publicComparison: "Fixture only" }));
    const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" };
    const options = { cwd: root, env, encoding: "utf8" };
    const output = execFileSync("python3", ["tools/discovery/read-decisions.py", "--state", path.join(dir, "state.json"),
      "--output", path.join(dir, "decisions.json")], options);
    assert.equal(JSON.parse(output).source, "saved_state");
    execFileSync(process.execPath, ["tools/discovery/daily-review.mjs", "--state", path.join(dir, "state.json"),
      "--review", path.join(dir, "review.json"), "--date", "2026-11-22", "--output", path.join(dir, "payload.json"),
      "--next-state", path.join(dir, "next.json")], options);
    const payload = JSON.parse(await fs.readFile(path.join(dir, "payload.json"), "utf8"));
    const next = JSON.parse(await fs.readFile(path.join(dir, "next.json"), "utf8"));
    assert.equal(payload.rows.length, 1);
    assert.equal(next.daily_discovery.decisionReader, "saved_state");
    assert.equal(next.daily_discovery.feedbackPolicy.requireCloudflare, false);
    assert.deepEqual(next.usernames, s.usernames);
    assert.equal(next.last_completed_collection_at, s.last_completed_collection_at);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
