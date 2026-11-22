// Discovery review decisions live in the private review state. No network access.
import { validDecisionId } from "../../shared/discovery-identity.js";

export function decisionRecords(input) {
  if (input === undefined) return [];
  const items = Array.isArray(input) ? input : input?.records ?? input?.result;
  if (!Array.isArray(items)) throw new Error("Saved decisions must contain a records array; preserve the existing state.");
  return items.map(item => {
    const record = item?.metadata ? { ...item.metadata, alias: item.alias || item.name?.split(":").at(-1) } : item;
    if (!record || !validDecisionId(record.id) || !["event", "correction"].includes(record.kind)
        || !["INCLUDE", "WAIT", "EXCLUDE"].includes(record.decision)
        || !/^\d{4}-\d{2}-\d{2}$/.test(record.date || "") || !Number.isFinite(Date.parse(record.updatedAt))
        || (record.alias != null && !validDecisionId(record.alias))
        || (record.aliases != null && (!Array.isArray(record.aliases) || !record.aliases.every(validDecisionId)))) {
      throw new Error("A saved decision is invalid; recover it without resetting the decision history.");
    }
    return { ...record };
  });
}

export function mergeDecisionRecords(...inputs) {
  const records = new Map();
  for (const input of inputs) for (const record of decisionRecords(input)) {
    // Correction receipts and Wait choices affect only that proposal. An Exclude
    // also follows event/source aliases, as in existing exported decision files.
    const aliases = record.alias ? [record.alias]
      : record.kind === "correction" && record.decision !== "EXCLUDE" ? [record.id]
      : [...new Set([record.id, ...(record.aliases || [])])];
    for (const alias of aliases) {
      const prior = records.get(alias);
      if (!prior || Date.parse(record.updatedAt) >= Date.parse(prior.updatedAt)) records.set(alias, { ...record, alias });
    }
  }
  return [...records.values()];
}

export function savedDecisionFeedback(state, records = decisionRecords(state.daily_discovery?.decisions), input) {
  const live = input?.source === "apps_script" && input.complete === true;
  if (live && (!Number.isFinite(Date.parse(input.lastLiveSyncAt)) || !/^[a-f0-9]{64}$/.test(input.revision || "")
      || input.total !== input.records?.length)) throw new Error("The Apps Script decision snapshot is incomplete.");
  return {
    source: live ? "apps_script" : "saved_state", records: records.length,
    lastLiveSyncAt: live ? input.lastLiveSyncAt : state.daily_discovery?.decisionReadAt || null,
    revision: live ? input.revision : null,
    liveAdminFeedback: live ? "Synced directly from the Apps Script discovery decision ledger."
      : "Not synced this run. Saved decisions are preserved; retry the configured Apps Script reader on the next run.",
    ...(input?.feedbackReadError ? { feedbackReadError: input.feedbackReadError } : {})
  };
}

export function useSavedDecisionState(state, records = decisionRecords(state.daily_discovery?.decisions)) {
  const daily = { ...(state.daily_discovery || {}) };
  const retired = { ...(daily.retiredDecisionConfiguration || {}) };
  for (const name of ["decisionFeed", "decisionStore"]) if (Object.hasOwn(daily, name)) {
    retired[name] = daily[name];
    delete daily[name];
  }
  if (daily.decisionReader && !["saved_state", "apps_script"].includes(daily.decisionReader)) retired.decisionReader = daily.decisionReader;
  if (Object.keys(retired).length) daily.retiredDecisionConfiguration = { ...retired, disabled: true };
  const connected = daily.appsScriptFeedback?.provider === "apps_script" && daily.appsScriptFeedback.enabled !== false;
  return {
    ...state, restrictions: { ...(state.restrictions || {}), no_cloudflare_access: true },
    daily_discovery: {
      ...daily, decisionReader: connected ? "apps_script" : "saved_state", feedbackReader: connected ? "apps_script" : "saved_state", decisions: records,
      feedbackPolicy: {
        version: 3, readFrom: connected ? "Apps Script discovery decision ledger" : "daily_discovery.decisions",
        writeTo: "Admin saves decisions and confirmed intake receipts in the Apps Script ledger; reviews cache them in daily_discovery.decisions.",
        requireLiveFeedback: false, requireCloudflare: false,
        persistence: "Save the next state to the same private Library item with its current version guard.",
        adminFeedback: connected ? "Read the configured Apps Script decisions-only feed before every review. No manual export or Cloudflare access."
          : "Connection not activated. Preserve saved decisions until the Apps Script reader is configured."
      }
    }
  };
}
