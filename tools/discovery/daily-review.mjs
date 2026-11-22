// Deterministic preparation for the ChatGPT daily review. No collection or QDP writes.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { discoveryIdentity } from "../../shared/discovery-identity.js";
import { mergeDecisionRecords, savedDecisionFeedback, useSavedDecisionState } from "./saved-decisions.mjs";
export { decisionRecords } from "./saved-decisions.mjs";

export const SETTINGS = Object.freeze({
  postsPerProfile: 3, overlapHours: 6, maxDailyActorChargeUsd: 0.59,
  inspectEdits: false, timezone: "America/New_York",
  venues: [
    { name: "Val's", urls: ["https://valslesbianbar.com/events", "https://valslesbianbar.com/calendar.html"] },
    { name: "Dolphin Tavern", urls: ["https://www.dolphinphillyinfo.com/upcoming-events"] },
    { name: "Warehouse on Watts", urls: ["https://www.wowphilly.com/events"] }
  ]
});

export const CORRECTION_HEADERS = ["Date", "Current title", "Correction", "Venue", "Instagram source",
  "Apply to existing event only", "Suggested Description", "RawFlyerURL", "Public listing",
  "Suggested StartDate", "Suggested StartTime", "Suggested EndDate", "Suggested EndTime"];

export function collectionPlan(state, now = new Date(), spentToday = 0) {
  const prior = new Date(state.last_completed_collection_at || state.baseline_asof);
  if (!Number.isFinite(+prior)) throw new Error("The last collection checkpoint is missing; do not invent a cutoff.");
  const remaining = Math.floor((SETTINGS.maxDailyActorChargeUsd - spentToday) * 100 + 1e-7) / 100;
  if (remaining <= 0) throw new Error("Today's actor budget is exhausted. Reuse saved results.");
  return {
    actor: state.actor, usernames: state.usernames,
    postsPerProfile: 3, newerThan: new Date(+prior - 6 * 3600000).toISOString(),
    memoryMb: 1024, timeoutSeconds: 1800, maxTotalChargeUsd: remaining,
    planCreatedAt: now.toISOString()
  };
}

export function fieldsFor(candidate) {
  if (candidate.fields) return { ...candidate.fields };
  const nextDate = candidate.date && candidate.nextDay
    ? new Date(Date.parse(candidate.date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) : candidate.date;
  return {
    "Title (internal)": candidate.title || "", StartDate: candidate.date || "",
    EndDate: candidate.end_date || nextDate || "", StartTime: candidate.start || "",
    EndTime: candidate.end || "", Timezone: "America/New_York",
    "ExplicitQueer (Yes/No)": candidate.explicitQueer || "", Location: candidate.location || candidate.venue || "",
    Description: candidate.description || "", Lineup_Raw: Array.isArray(candidate.lineup) ? candidate.lineup.join("; ") : candidate.lineup || "",
    RawFlyerURL: candidate.flyer_url || "", Event_URL: candidate.source_url || candidate.event_url || "",
    Instagram_URL: /instagram\.com\//.test(candidate.source_url || "") ? candidate.source_url : "",
    Review_notes: candidate.notes || "", ImportSourceKey: candidate.discoveryId ? "qdp-discovery:v1:" + candidate.discoveryId : ""
  };
}

function decisionFor(identity, records) {
  return records.filter(record => identity.aliases.includes(record.alias || record.id)
    && (record.kind === identity.kind || ["EXCLUDE", "WAIT"].includes(record.decision))
    && (identity.kind !== "correction" || record.id === identity.id || ["EXCLUDE", "WAIT"].includes(record.decision)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

export async function prepareReview(state, review, decisionInput, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("Supply today's Philadelphia date.");
  if (!Array.isArray(state.intake_headers) || state.intake_headers.length !== 43) throw new Error("Use the saved 43-column intake layout.");
  const records = mergeDecisionRecords(state.daily_discovery?.decisions, decisionInput);
  const candidates = new Map();
  const excluded = [], expired = [], included = [];
  const freshlyListed = new Set(review.listedIds || []);
  // Legacy deliveries are retained: delivery never established an import.
  for (const original of [...(state.previously_delivered_candidates || []), ...(state.daily_discovery?.excludedCandidates || []),
    ...(state.pending_candidates || []), ...(review.candidates || [])]) {
    const fields = fieldsFor(original);
    const identity = await discoveryIdentity(fields);
    const match = [...candidates.values()].find(item => item.discovery.aliases.some(alias => identity.aliases.includes(alias)));
    const id = match?.discovery.id || identity.id;
    const aliases = [...new Set([id, ...(match?.discovery.aliases || []), ...identity.aliases])].slice(0, 8);
    const discovery = { ...identity, id, aliases };
    candidates.set(id, { ...original, fields, discovery });
  }
  const actionable = [];
  for (const item of candidates.values()) {
    const { fields, discovery } = item;
    const disposition = decisionFor(discovery, records);
    if ((fields.EndDate || fields.StartDate) < today) { expired.push(item); continue; }
    if (disposition?.decision === "EXCLUDE") { excluded.push(item); continue; }
    if (disposition?.decision === "INCLUDE" || discovery.aliases.some(id => freshlyListed.has(id))) { included.push(item); continue; }
    // Missing lineups remain leads. A later NEW post can make them actionable.
    if (!fields.Lineup_Raw?.trim()) { item.leadWithoutLineup = true; continue; }
    fields.ImportSourceKey = "qdp-discovery:v1:" + discovery.id;
    fields.ImportSourceSnapshot = JSON.stringify({ discovery });
    fields.Review = fields.RawFlyerURL ? "Include" : "Hold";
    fields["Import readiness"] = fields.RawFlyerURL ? "Ready for Admin review" : "HOLD: Find a usable event flyer";
    const carriedNote = "Carried forward: awaiting your decision.";
    fields.Review_notes = [fields.Review_notes, item.carried && !fields.Review_notes?.includes(carriedNote) ? carriedNote : ""].filter(Boolean).join(" ");
    // Automation-owned calendar/ID/location columns are deliberately blank.
    for (const name of ["Loc_Manual", "EventID", "CalendarEventId", "CalendarCreateId", "Saved_Flyer_URL", "Flyer_URL"]) fields[name] = "";
    actionable.push(item);
  }
  actionable.sort((a, b) => a.fields.StartDate.localeCompare(b.fields.StartDate)
    || a.fields.StartTime.localeCompare(b.fields.StartTime)
    || a.fields["Title (internal)"].localeCompare(b.fields["Title (internal)"]));

  const corrections = new Map(), excludedCorrections = new Map();
  for (const original of [...(state.daily_discovery?.excludedCorrections || []), ...(state.daily_discovery?.pendingCorrections || []), ...(review.corrections || [])]) {
    const row = { ...original };
    row.Date ||= row.date || "";
    row["Current title"] ||= row.title || "";
    row.Venue ||= row.venue || "";
    row.Correction ||= row.correction || "";
    row["Instagram source"] ||= row.source_url || "";
    row["Public listing"] ||= row.public_url || row.eventUrl || "";
    row["Suggested Description"] ||= row.suggestedDescription || "";
    row.RawFlyerURL ||= row.flyer_url || "";
    row["Apply to existing event only"] ||= row.note || "Update the existing QDP event; do not create a new event.";
    if (row["Suggested Lineup_Raw"] && !/Proposed lineup:/i.test(row.Correction)) row.Correction += "\nProposed lineup: " + row["Suggested Lineup_Raw"];
    // Keep the legacy Corrections columns. The reader understands this proposal text.
    const proposal = JSON.stringify([row.Correction, row["Suggested Description"], row["Suggested StartDate"] || "",
      row["Suggested StartTime"] || "", row["Suggested EndDate"] || "", row["Suggested EndTime"] || "", ""]);
    const identity = await discoveryIdentity({ StartDate: row.Date, Location: row.Venue,
      "Title (internal)": row["Current title"], Instagram_URL: row["Instagram source"] }, "correction", proposal);
    const disposition = decisionFor(identity, records);
    if (row.Date < today || disposition?.decision === "INCLUDE"
      || (review.resolvedCorrectionIds || []).includes(identity.id)) continue;
    if (disposition?.decision === "EXCLUDE") { excludedCorrections.set(identity.id, row); continue; }
    corrections.set(identity.id, row);
  }
  const pending = [...candidates.values()].filter(item => ![...included, ...excluded, ...expired].includes(item));
  const coverage = { ...(review.coverage || {}), preparedAt: new Date().toISOString(),
    decisionFeedback: savedDecisionFeedback(state, records),
    publicComparison: review.publicComparison || "Incomplete: public calendar comparison must be performed by the daily review.",
    candidates: actionable.length, corrections: corrections.size, excluded: excluded.length, expired: expired.length,
    includedOrAlreadyListed: included.length, waitingForLineup: pending.filter(item => item.leadWithoutLineup).length };
  const localState = useSavedDecisionState(state, records);
  return {
    headers: state.intake_headers, rows: actionable.map(item => state.intake_headers.map(name => item.fields[name] || "")),
    corrections: [...corrections.values()], correctionHeaders: CORRECTION_HEADERS, coverage,
    nextState: { ...localState, pending_candidates: pending.map(item => ({ ...item, carried: true })),
      daily_discovery: { ...localState.daily_discovery, version: 1, settings: SETTINGS,
        pendingCorrections: [...corrections.values()], excludedCorrections: [...excludedCorrections.values()],
        excludedCandidates: excluded, lastPreparedDate: today,
        decisions: records, lastCoverage: coverage } }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) =>
    arg.startsWith("--") ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs, []));
  const read = path => fs.readFile(path, "utf8").then(JSON.parse);
  const state = await read(args.state);
  if (args.plan) {
    await fs.writeFile(args.plan, JSON.stringify(collectionPlan(state, new Date(), Number(args.spent || 0)), null, 2));
  } else {
    const result = await prepareReview(state, await read(args.review), args.decisions ? await read(args.decisions) : undefined, args.date);
    const { nextState, ...payload } = result;
    await fs.writeFile(args.output, JSON.stringify(payload));
    await fs.writeFile(args["next-state"], JSON.stringify(nextState, null, 2));
  }
}
