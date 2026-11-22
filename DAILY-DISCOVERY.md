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

The discovery run reads and saves decisions in the private
`QDP_Instagram_Review_State.json` item. **No Cloudflare account connection,
API, KV read/write, Admin endpoint, protected decision feed, Worker, new endpoint
or security configuration is required to collect, review, save progress or export
the workbook.** Do not ask for Cloudflare access to repair or run this workflow.
This policy replaces the former account-API requirement, including the old
preflight failure recorded in run history.

`daily_discovery.decisionReader` and `feedbackReader` are `saved_state`.
`daily_discovery.feedbackPolicy` defines local reads and writes. Older feed/store
settings and credentials are retained only under
`daily_discovery.retiredDecisionConfiguration`, disabled for execution.
The helpers never follow those settings.

The preparation helper automatically uses `daily_discovery.decisions`. Its
`--decisions` argument is optional and accepts a local decision export explicitly
provided by the user. It merges newer choices with existing history by stable
identity/alias and timestamp; an omitted or partial export never erases saved
exclusions or confirmed import receipts. Invalid saved records must be recovered,
not silently discarded. Save the resulting `NEXT_STATE.json` to the same private
Library item using the current version guard. That save persists the review's
choices and progress without a remote decision write.

If no decision snapshot has ever been saved, the run proceeds with zero **known
saved** decisions. This is not evidence that Admin has no exclusions. The helper
records the snapshot's source, actual last live-sync timestamp (or unknown) and
freshness limitation in Coverage. Missing live feedback never blocks collection,
review, local decision saves, Excel generation or delivery. Do not invent a new
sync timestamp when preparing a workbook.

Admin still restores its own latest saved choices when a workbook is opened
there. Those choices are not automatically copied into the daily review state.
Consequently a workbook may contain an item already excluded or saved in Admin.
Record this limitation rather than requesting access or claiming a live sync.
The Admin application and its existing storage are separate from this task.

| Known saved decision | Next scan |
| --- | --- |
| Include | Retire after confirmed intake success or a match through the normal public-calendar comparison. Delivery is not an import receipt. |
| Wait | Carry the latest unresolved future event/proposal without importing it. Untouched rows default to Wait. |
| Exclude | Suppress that edition across workbooks and cross-posts using known identities/aliases. A different date is a different edition. A newer known Wait restores it. |

Source/event aliases and stable IDs remain in `ImportSourceKey` and
`ImportSourceSnapshot`. Reuse a pending event's ID when new evidence confirms the
same edition. Do not collapse different editions, rooms or simultaneous events
because they share a post or address. Correction receipts are proposal-specific.

Every daily Excel is cumulative. Preserve unresolved leads and meaningful updates,
replace superseded pending proposals, expire past events, and record dispositions.
Keep decision-excluded items in the saved backlog so a newer Wait can restore
them. Older deliveries do not prove an import. Preserve unrelated history and the
state's optimistic version guard.

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
# No live feedback or external account connection is required.
# This optional export reads only the local state snapshot.
python3 tools/discovery/read-decisions.py --state STATE.json --output decisions.json
node tools/discovery/daily-review.mjs --state STATE.json --plan collection.json --spent 0
python3 tools/discovery/collect-venues.py --output venues.json
```

The ChatGPT review supplies evidence-checked JSON with `candidates`, `corrections`,
`listedIds` (persistent identities matched by the normal public-calendar check),
`resolvedCorrectionIds`, `coverage` and `publicComparison`. The helper preserves
the historical `decisionReadAt`; do not supply a new one without an actual sync.
New candidates may use the saved legacy fields or a `fields` object with intake
headers. Preserve all supported dates, times, named artists, descriptions, source
URLs and direct image URLs. List relevant accounts, media, source and comparison
gaps in Coverage. No fabricated minimum event count.

```sh
node tools/discovery/daily-review.mjs --state STATE.json --review reviewed.json \
  --date YYYY-MM-DD --output payload.json --next-state NEXT_STATE.json
node tools/discovery/export-workbook.mjs --payload payload.json \
  --template ACCEPTED_REFERENCE.xlsx --output QDP_Instagram_Review_YYYY-MM-DD.xlsx
```

The preparation command saves candidate/correction progress and the merged
known decision snapshot in `NEXT_STATE.json`. It does not contact the decision
service. To merge an explicitly supplied local decision export, add
`--decisions PROVIDED_DECISIONS.json`; a live decision read is never required.
Save the workbook and replace the same private state item after generation.

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
