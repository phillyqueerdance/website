// Shared by the workbook reader and the authenticated decision store.
export const DECISION_PREFIX = "qdp-discovery-decision:v1:";
export const SOURCE_PREFIX = "qdp-discovery:v1:";
export const validDecisionId = value => /^[a-f0-9]{64}$/.test(value || "");

export function normalized(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sourceReference(value) {
  try {
    const url = new URL(value);
    const instagram = /(?:^|\.)instagram\.com$/i.test(url.hostname);
    const post = /^\/(?:p|reel|tv)\/([^/]+)/.exec(url.pathname);
    if (instagram && post) return "ig:" + post[1];
    return url.hostname.toLowerCase().replace(/^www\./, "") + url.pathname.replace(/\/$/, "");
  } catch { return ""; }
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export async function discoveryIdentity(fields, kind = "event", proposal = "") {
  const date = String(fields.StartDate || "").slice(0, 10);
  const venue = normalized(fields.Location);
  const title = normalized(fields["Title (internal)"]);
  const eventAlias = await digest(["event", date, venue, title].join("|"));
  const source = sourceReference(fields.Instagram_URL || fields.Event_URL);
  const aliases = [eventAlias];
  if (source) aliases.push(await digest(["source", date, venue, source].join("|")));
  const supplied = String(fields.ImportSourceKey || "");
  let id = supplied.startsWith(SOURCE_PREFIX) ? supplied.slice(SOURCE_PREFIX.length) : eventAlias;
  if (!validDecisionId(id)) id = eventAlias;
  try {
    const saved = JSON.parse(fields.ImportSourceSnapshot || "{}").discovery;
    if (saved?.id === id && Array.isArray(saved.aliases)) aliases.push(...saved.aliases.filter(validDecisionId));
  } catch { /* Legacy workbooks have no discovery metadata. */ }
  if (kind === "correction") {
    // A saved correction retires this proposal, not future evidence for the event.
    id = await digest(["correction", id, source, proposal].join("|"));
  }
  return { id, aliases: [...new Set([id, ...aliases])].slice(0, 8), kind, date };
}

export function validateIdentity(value) {
  if (!value || !validDecisionId(value.id) || !["event", "correction"].includes(value.kind)
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.date || "") || !Array.isArray(value.aliases)
      || !value.aliases.length || value.aliases.length > 8 || !value.aliases.every(validDecisionId)) {
    throw new Error("An event decision is invalid. Reload its workbook.");
  }
  return { id: value.id, aliases: [...new Set([value.id, ...value.aliases])], kind: value.kind, date: value.date };
}
