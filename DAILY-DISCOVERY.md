# QDP daily discovery — persistent Admin inbox

The combined discovery task runs at its existing 08:00 America/New_York schedule.
It performs the complete source and visual review and delivers findings directly
to https://queerdancephilly.com/admin/discovery. Excel is an optional export.

## Authoritative state and access

Use the private QDP Discovery Connection file named in the scheduled task. Send
its token only in the Authorization header to its exact HTTPS /api/discovery URL.
Use tools/discovery/inbox-client.py; it refuses credential-bearing redirects.
The task credential permits review-state reads/writes, a bounded QDP snapshot,
and preserving candidate flyers. It cannot import, publish, change user decisions,
deploy code, change Cloudflare settings, or manage credentials. No continuing
Cloudflare account connection or write permission is required.

D1 holds the roster, screening markers, pending proposals, user edits and decisions,
run checkpoints, budget reservations and import receipts. The old private review
state remains a recovery/audit checkpoint; never rebuild or replace it each day.
Read the current inbox state at every review. Do not rely on scratch surviving.

Google and Cloudflare are authorized for this QDP workflow. Use only QDP-specific
resources. Old no-Google/no-Cloudflare instructions in historical state and runs
are superseded. Do not publish private state, source rosters, or credentials in Git.

## Preflight and collection

Read bootstrap/review-state and snapshot before paid collection. The snapshot
must report inboxVersion=1. If Apps Script has not been installed/deployed, report
the exact activation blocker and do not spend actor credits. The snapshot includes
Events (including unpublished drafts), pending intake, relevant Calendar entries,
and entity aliases. Match stable source IDs first, then edition date + venue +
title; preserve rooms and simultaneous events. Use public pages only to resolve
specific ambiguity or confirm public presentation. Incomplete matching is never
proof of absence. Never automatically Pull, import, create Calendar entries, or
publish during discovery review.

Keep the approved roster (currently 425 accounts); never refresh follows/followers.
Use only sones/instagram-posts-scraper-lowcost, solely for QDP event collection.
Check current schema/pricing before starting. postsPerProfile=3, 1024 MB, timeout
1800 seconds; cutoff is the last successful collection minus six hours.

Before every start or retry, atomically call budget.reserve with a unique ID and
the remaining Philadelphia-day allowance. The total is capped at USD 0.59/day.
A created=false reservation is NOT permission to start again. Resume its recorded
actor run; an unknown start/charge keeps the full reservation unavailable.
Persist actor run/dataset/store IDs immediately with run.save and checkpoint.
Set callOptions.maxTotalChargeUsd to the reserved remaining allowance. Settle
only the scraper's confirmed actual charge, never an estimate. Reuse completed
collection after an interruption. No purchases, top-ups, billing changes, paid
AI APIs, additional actor schedules, or deeper/lookback runs.

Skip previously screened post IDs completely, including edited captions/replaced
posters. For every new post review its caption and every available carousel slide,
including posts without event keywords. Use contact sheets and full-size images
where needed. Track downloads, actual visual inspection, sampled video frames and
unavailable media separately. Do not claim full video/audio review. Preserve all
known deferred initial failures; do not investigate or backfill them in this task.
Record per-profile outcomes honestly; a successful run is not full account coverage.

Use tools/discovery/collect-venues.py for the existing free Val's, Dolphin Tavern,
and Warehouse on Watts checks, plus the existing public discovery searches.
Verify source details and named edition-specific performers. All Philadelphia
DJ-centered dance parties qualify regardless of genre or queer identity; queer,
sapphic and trans relevance affects ranking only. Exclude NOTO and The Ave Live/
The Ave from discovery. Rank today, tomorrow, next seven days, days 8–14, then later
findings, chronologically. Keep unresolved/missing-lineup leads as waiting records.
New recommendations require a confirmed named lineup and a usable flyer.

## Review and delivery

Keep concise, factual promotional descriptions. No URLs or process/evidence notes
in Description. Preserve verified hours; assume only missing boundaries (10 PM /
2 AM), explicitly note assumptions and correct overnight dates. Never invent
atmosphere, performers, identities or restrictions. Prefer the actual Instagram
post URL in Event_URL. Leave Loc_Manual to the owner.

Before creating a new proposal, reuse the matching pending discovery identity.
Do not create duplicate records for cross-posts or unchanged carry-forward items.
Keep undated and incomplete leads visible with their exact missing requirements.
New evidence can update a lead, while user edits and saved decisions remain owned
by the inbox. Exclude suppresses the edition; a later Wait can restore it.
Include is selection intent. Only confirmed Google import/publication receipts
establish completion; delivery or staging is not completion.

Use the existing EventID for corrections and propose only supported fields. A new
post can supply a later proposal for the same event. Lineup-only corrections do
not touch Calendar. Attach the fresh snapshot record as baseline; preserve the
field-by-field human selection in Admin. No historical lineup/flyer backfill.

Prepare evidence-checked JSON with candidates and corrections. Run:

```sh
python3 tools/discovery/inbox-client.py --connection CONNECTION.json --action review-state --output inbox-state.json
python3 tools/discovery/inbox-client.py --connection CONNECTION.json --action snapshot --output snapshot.json
node tools/discovery/inbox-payload.mjs --review reviewed.json --snapshot snapshot.json --output payload.json
python3 tools/discovery/inbox-client.py --connection CONNECTION.json --action deliver --input payload.json --output delivery.json
```

Preserve the chosen flyer for ready candidates with the flyers operation (up to
three per call), before staging; write its returned public Drive URL to Flyer_URL.
Reuse that saved URL on future runs. Missing/unavailable media remains an honest
coverage gap and waiting lead. Do not copy every scraped image into Drive.

Save screening markers with screened-posts (up to thirty per request), progress
with run.save, and the checkpoint with its exact current version. Read/reconcile
a version conflict; never force over a newer checkpoint. Keep activeRun until all
review/progress/delivery writes are confirmed. Record actual coverage and counts.

Return the verified Admin inbox link, concise new/updated/waiting/correction counts,
actor charges or clearly labeled unknown reservations, and material gaps. Include
verified venue/policy news and independent QDP/Callaia/Melt mentions separately.
No workbook generation is required; use Admin Download Excel when requested.

## Owner import

The signed-in owner edits proposals and saves Include / Wait / Exclude. Add selected
to QDP processes up to five proposals per request and starts immediately. It saves
flyers, matches IDs, writes Events, creates Calendar entries with stable retry IDs,
and refreshes public data once after the selection. Per-item failures retain their
progress and can be retried. Initial rows stay unpublished until Calendar creation
is confirmed. Existing Push/Pull remain direct. Archive Review is separate.

## Deployment

Install complete Core.gs v7.4.31; add DiscoveryInbox.gs; replace the supplied
scraper.gs with the batched version. Keep Imports.gs, ApifyAdminImport.gs,
PublicData.gs, other scripts, properties and triggers. Update the existing web-app
deployment to a new version. No URL changes or setup rerun is needed. The receipts
tab is created only when a correction is first committed.

Backend: QDP_DISCOVERY D1 binding, QDP_DISCOVERY_TASK_TOKEN secret, existing Admin
Access settings and QDP_APPS_SCRIPT_URL/QDP_ADMIN_SHARED_SECRET. Preview uses a
separate database. Never bind preview to production review data.

Validation: QDP_CORE_SOURCE=/path/to/Core.gs node --test tests/*.test.mjs
