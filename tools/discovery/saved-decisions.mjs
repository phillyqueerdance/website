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

export function savedDecisionFeedback(state, records = decisionRecords(state.daily_discovery?.decisions)) {
  return {
    source: "saved_state", records: records.length,
    lastLiveSyncAt: state.daily_discovery?.decisionReadAt || null,
    liveAdminFeedback: "Not synced. New Admin choices are applied in Admin when the workbook is opened; they are not automatically copied into this review state."
  };
}

export function useSavedDecisionState(state, records = decisionRecords(state.daily_discovery?.decisions)) {
  const daily = { ...(state.daily_discovery || {}) };
  const retired = { ...(daily.retiredDecisionConfiguration || {}) };
  for (const name of ["decisionFeed", "decisionStore"]) if (Object.hasOwn(daily, name)) {
    retired[name] = daily[name];
    delete daily[name];
  }
  if (daily.decisionReader && daily.decisionReader !== "saved_state") retired.decisionReader = daily.decisionReader;
  if (Object.keys(retired).length) daily.retiredDecisionConfiguration = { ...retired, disabled: true };
  return {
    ...state, restrictions: { ...(state.restrictions || {}), no_cloudflare_access: true },
    daily_discovery: {
      ...daily, decisionReader: "saved_state", feedbackReader: "saved_state", decisions: records,
      feedbackPolicy: {
        version: 2, readFrom: "daily_discovery.decisions", writeTo: "daily_discovery.decisions",
        requireLiveFeedback: false, requireCloudflare: false,
        persistence: "Save the next state to the same private Library item with its current version guard.",
        adminFeedback: "Not automatically synced. Merge a newer decision export only when explicitly supplied by the user."
      }
    }
  };
}
