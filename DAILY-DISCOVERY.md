# QDP combined daily discovery

One ChatGPT task starts daily at **08:00 America/New_York**. It replaces the
Monday/Wednesday/Friday Instagram review and the separate daily nightlife report.
The output remains the accepted Excel workbook and manual Admin import workflow.

## Collection

- Use the saved approved roster in `QDP_Instagram_Review_State.json`; never refresh
  followers/following or publish this private state into Git.
- Actor: `sones/instagram-posts-scraper-lowcost`. Fetch its current schema/pricing.
  Maximum **3 posts per profile**, `newerThan` equal to the last successful
  collection minus **six hours**, normally 1024 MB and a 1800-second timeout.
- Cap **all actor charges for the Philadelphia calendar day at $0.59**. This is
  deliberately below the user's $0.60 ceiling, includes starts and retries, and
  has no monthly cap. Use `callOptions.maxTotalChargeUsd` with the remaining daily
  budget. Reserve/persist each run's authorized budget before starting it; retain
  that reservation until its actual charge is known. If unknown, do not spend it
  again. Resume existing runs/reviews after interruption rather than recollecting.
- Use existing included/prepaid credits only. No purchases, top-ups, subscriptions,
  overage/billing changes, or separately billed AI APIs. No deeper/lookback runs.
- Screen each new post's caption and available carousel slides. A previously
  reviewed post ID is not rechecked for edited captions or replaced posters.
  Retain existing review gaps honestly; never infer a successful image review
  from a download or OCR. New posts can update older event leads.
- Retain per-profile success/failure history. A successful actor run does not
  establish full account coverage. Report three-post depth gaps and failures.

Use `tools/discovery/collect-venues.py` for the three free public venue checks:

| Venue | Public schedule route |
| --- | --- |
| Val's | Its events page and the exact published-document API used by that public app. Never access staff/draft documents. |
| Dolphin Tavern | Its official upcoming-events page, embedded feed and new posts already in the approved Instagram collection. An unreadable embed is incomplete coverage. |
| Warehouse on Watts | Its full event-page source and linked Tixr event pages. Verify dates and lineups; the page also contains live shows and past events. |

Also run the existing public discovery searches: organizer/artist announcements,
Resident Advisor, ticketing sites, community calendars and local press. No paid
venue scraper or additional paid API is required. Review source details before
claiming a verified event. Source collection alone is not completed review.

## Feedback and pending events

Admin's **Include / Wait / Exclude** decisions are saved under
`qdp-discovery-decision:v1:` in the existing public-feed KV binding. The records
contain only stable event/proposal hashes, the decision and timestamps. Writes
require existing Cloudflare Access authentication and a same-origin request.
Five-item batches remain within the Workers Free subrequest limit.

The scheduled task reads only these decision keys and their metadata through the
connected Cloudflare account API. The private state identifies the existing
account, namespace and exact prefix in `daily_discovery.decisionStore`. Use
`GET /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys` with that
prefix and `limit=1000`; follow every `result_info.cursor`. Save the metadata as
`decisions.json`, retaining each key suffix as `alias`. This direct account read
was verified against production. It does not read any Calendar/index data.

A separate credential-protected `/api/discovery-decisions` endpoint and
`read-decisions.py` helper are available for compatible clients. Keep the
credential in the private state/production secret, send it only in Authorization,
and never log it. The current machine is rejected by the site's browser-signature
check, so the scheduled task must use the supported Cloudflare account API. Do not
retry that block, impersonate a browser or weaken site protections. No site-wide
or endpoint-specific browser-check exception is required. If the account read
fails, do not assume an empty exclusion list or launch paid collection.

| Decision | Next scan |
| --- | --- |
| Include | Retire the item after the existing intake save is confirmed. A failed save remains pending; a lost response can retry the same existing workbook key. |
| Wait | Carry the latest unresolved future event/proposal into the next file without importing it. Untouched rows default to Wait. |
| Exclude | Suppress that event edition across workbooks and cross-posts. A different date is a different edition. Changing a saved choice back to Wait restores it. |

Source/event aliases and stable IDs are stored in the existing `ImportSourceKey`
and `ImportSourceSnapshot` columns. Reuse a pending event's ID when new source
evidence confirms it is the same edition. Do not collapse different editions,
rooms, or simultaneous events based only on one shared post or address.

Every daily Excel is cumulative. Preserve unresolved leads and meaningful updates,
replace superseded pending proposals, expire past events, and record dispositions.
Older deliveries do not prove an import. Do not let a stale worker overwrite the
latest Library state: retain and use its optimistic version guard.

## Normal QDP comparison and corrections

**Keep the existing comparison against the live public QDP calendar.** Fetch its
overview once per cycle and inspect relevant individual event pages for ambiguous
matches. Match date + venue + title/aliases, consolidate cross-posts, omit unchanged
listed events, and identify factual changes or missing-flyer updates. A manually
added event visible publicly is recognized here. There is no extra Calendar/index
reconciliation, automatic Pull, or new import-time live reconciliation.

All Philadelphia DJ-centered dance parties are eligible regardless of genre or
queer identity. Rank queer/sapphic/trans relevance; do not use it as an exclusion.
Always exclude NOTO and The Ave Live/The Ave. Prioritize today, tomorrow, the next
seven days, then days 8–14, then later discoveries; order chronologically.
Require a confirmed named lineup for new recommendations, not for retaining a lead.

An existing event without a lineup can receive a correction when a **new post**
announces the edition's named artists or updated poster. Compare new evidence
against that public listing before the new-event lineup gate. Use the existing
EventID and propose only supported fields, including an updated factual description
when appropriate. No general missing-`Lineup_Raw` scan or historical backfill.

The Corrections sheet keeps its existing columns. Put a proposed lineup on a
separate `Proposed lineup: ...` line in Correction, or accept the optional
`Suggested Lineup_Raw` column from older/custom workbooks. Admin provides a selectable
Lineup field. A saved correction's receipt retires only that proposal; a different
new post can still yield a later correction. Exclude applies to the event edition.

The supplied **Core.gs v7.4.28** adds `lineup` to correction staging and writes it
only to `Lineup_Raw` through the existing field-selected correction application.
Lineup-only changes do not read or write Google Calendar. Description/time/flyer
behavior and existing shared save rules are preserved. The source delta is in
`apps-script/apify-lineup-corrections.patch`; keep the rest of the bound project,
its URL, permissions, data and triggers. Replace Core.gs and update the existing
web-app deployment to a new version to activate that server-side field.

## Preparing the workbook

Fetch the latest private state and the current repository before every task.

```sh
# First fetch decisions.json through the connected Cloudflare API, using only
# daily_discovery.decisionStore and following every cursor.
node tools/discovery/daily-review.mjs --state STATE.json --plan collection.json --spent 0
python3 tools/discovery/collect-venues.py --output venues.json
```

The ChatGPT review supplies evidence-checked JSON with `candidates`, `corrections`,
`listedIds` (persistent identities matched by the normal public-calendar check),
`resolvedCorrectionIds`, `coverage`, `publicComparison` and `decisionReadAt`.
New candidates may use the saved legacy fields or a `fields` object with intake
headers. Preserve all supported dates, times, named artists, descriptions, source
URLs and direct image URLs. List relevant accounts, media, source and comparison
gaps in Coverage. No fabricated minimum event count.

```sh
node tools/discovery/daily-review.mjs --state STATE.json --review reviewed.json \
  --decisions decisions.json --date YYYY-MM-DD --output payload.json --next-state NEXT_STATE.json
node tools/discovery/export-workbook.mjs --payload payload.json \
  --template ACCEPTED_REFERENCE.xlsx --output QDP_Instagram_Review_YYYY-MM-DD.xlsx
```

The exporter uses the Codex primary runtime's Artifact Tool. Run with
`CODEX_PRIMARY_RUNTIME_NODE`; it resolves dependencies from
`CODEX_PRIMARY_RUNTIME_NODE_MODULES`. Use the accepted reference to preserve its
formatting. Keep four tabs, the exact 43 ordered New events columns, typed dates
and times, and the existing Corrections columns. Save the Excel and replace the
same state item through the Library workflow; never leave durable progress only
in scratch. Generated workbooks and private state must not be committed to Git.

Use the original Instagram post for Event_URL when available. Keep URLs out of
Description, all process notes in Review_notes, and automatic IDs/sync/flyer-save
fields and Loc_Manual blank for new events. Preserve verified hours; assume only
missing boundaries (10 PM start / 2 AM end), mark each assumption and correct the
overnight date. Unclear dates/conflicts or missing usable flyers remain on Hold.

Deliver the Excel even if no new findings, with concise counts and material
coverage gaps. Keep significant venue/policy news and independent mentions of
QDP/Callaia/Melt in the accompanying message. The user retains import selection,
flyer saving, Calendar creation, Push/Pull and publication.

Validation:

```sh
QDP_CORE_SOURCE=/path/to/Core.gs node --test tests/*.test.mjs
```
