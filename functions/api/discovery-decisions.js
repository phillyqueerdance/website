import { decisionStore } from "../discovery-decisions.js";
import { DECISION_PREFIX } from "../../shared/discovery-identity.js";

const json = (body, status = 200) => Response.json(body, {status, headers: {
  "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff"
}});

export async function onRequestGet({request, env}) {
  const expected = String(env.QDP_DISCOVERY_READ_TOKEN || "");
  const supplied = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "")?.[1] || "";
  if (!/^[a-f0-9]{64}$/.test(expected) || !supplied) return json({error: "Discovery read authorization required."}, 403);
  // Compare fixed-size digests without an early-exit comparison of the credential.
  const hashes = await Promise.all([expected, supplied].map(value => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const first = new Uint8Array(hashes[0]), second = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < first.length; i++) difference |= first[i] ^ second[i];
  if (difference) return json({error: "Discovery read authorization required."}, 403);
  const kv = decisionStore(env);
  if (typeof kv?.list !== "function") return json({error: "Discovery decisions are unavailable."}, 503);
  const cursor = new URL(request.url).searchParams.get("cursor") || undefined;
  if (cursor && cursor.length > 2048) return json({error: "Invalid cursor."}, 400);
  try {
    const page = await kv.list({prefix: DECISION_PREFIX, limit: 1000, cursor});
    const records = page.keys.filter(item => item.metadata).map(({name, metadata}) => ({
      alias: name.slice(DECISION_PREFIX.length), id: metadata.id, kind: metadata.kind,
      date: metadata.date, decision: metadata.decision, updatedAt: metadata.updatedAt
    }));
    return json({version: 1, records, cursor: page.list_complete ? null : page.cursor});
  } catch { return json({error: "Discovery decisions could not be read. Retry before preparing the workbook."}, 503); }
}
