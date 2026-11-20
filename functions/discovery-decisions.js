import { DECISION_PREFIX, validateIdentity } from "../shared/discovery-identity.js";

export const decisionStore = env => env.QDP_PUBLIC_FEED_KV || env.QDP_ARCHIVE_KV;

function requireStore(env) {
  const kv = decisionStore(env);
  if (typeof kv?.get !== "function" || typeof kv?.put !== "function") {
    throw new Error("Discovery decision storage is unavailable. Your choices have not been saved.");
  }
  return kv;
}

export async function readDiscoveryDecision(env, raw) {
  const identity = validateIdentity(raw);
  const kv = requireStore(env);
  const records = await Promise.all(identity.aliases.map(id => kv.get(DECISION_PREFIX + id, "json")));
  const eligible = records.filter(record => record && ["INCLUDE", "WAIT", "EXCLUDE"].includes(record.decision)
    && (record.kind === identity.kind || record.decision === "EXCLUDE")
    && (identity.kind !== "correction" || record.id === identity.id || record.decision === "EXCLUDE"));
  eligible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return eligible[0] || null;
}

export async function saveDiscoveryDecision(env, raw, decision, receipt = false) {
  const identity = validateIdentity(raw);
  if (!["WAIT", "EXCLUDE", ...(receipt ? ["INCLUDE"] : [])].includes(decision)) {
    throw new Error("Include is recorded only after a confirmed import. Choose Wait or Exclude to defer an event.");
  }
  const kv = requireStore(env);
  const record = { ...identity, decision, updatedAt: new Date().toISOString() };
  const metadata = { id: identity.id, kind: identity.kind, decision, date: identity.date, updatedAt: record.updatedAt };
  // Correction receipts are proposal-specific; Exclude also suppresses its event aliases.
  const keys = identity.kind === "correction" && decision !== "EXCLUDE" ? [identity.id] : identity.aliases;
  for (const id of keys) await kv.put(DECISION_PREFIX + id, JSON.stringify(record), { metadata });
  return record;
}

export async function recordDiscoveryImports(env, rows, result) {
  if (!rows?.some(row => row.discovery)) return;
  if (result.ok !== "yes" || !Number.isInteger(result.added) || !Number.isInteger(result.alreadySaved)
      || result.added + result.alreadySaved !== rows.length) {
    throw new Error("The import was not fully confirmed; its decisions remain pending.");
  }
  for (const row of rows) if (row.discovery) await saveDiscoveryDecision(env, row.discovery, "INCLUDE", true);
}
