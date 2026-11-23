# QDP daily discovery — persistent Admin inbox

This is the **single authoritative runbook** for the scheduled QDP discovery review.
The scheduled task supplies the private connection-file reference and points to
this document; it must not embed a second copy of these operating rules.
Read the current `main` version on every run. If this document cannot be read,
report the blocker and do not start paid collection. Do not fall back to an old
pasted copy or an earlier commit.

The combined discovery task runs at its existing 08:00 America/New_York schedule.
Use the actual run date and time in America/New_York.
It performs the complete source and visual review (collection alone is not completion)
and delivers findings directly
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
Never reset D1 from recovery copies or follow superseded restrictions from old runs.
Read the current inbox state at every review. Do not rely on scratch surviving.

**No direct Google or Cloudflare account access by ChatGPT.** Do not use
Google Drive, Google Sheets, Google Calendar, Google Cloud, or Cloudflare account
connectors, OAuth connections, account APIs, or account dashboards during this
discovery review. Do not request or rely on those permissions, even if connected.

Use only the restricted QDP discovery token to access the exact saved HTTPS
`/api/discovery` endpoint through `tools/discovery/inbox-client.py`. QDP's existing
Cloudflare backend and Google Apps Script may communicate with their own services
server-side, including reading the QDP snapshot and preserving selected flyers;
this is not ChatGPT accessing either account. If the restricted endpoint or a
required operation fails, report the blocker and do not fall back to direct
Google or Cloudflare account access. This rule overrides any broader authorization
in historical instructions, state, or past runs.

Do not publish private state, source rosters, or credentials in Git.

## Preflight and collection

Read bootstrap/review-state and snapshot before paid collection. The snapshot
must report inboxVersion=1. If the snapshot or required endpoint cannot be read, report
the exact connectivity blocker and do not spend actor credits. Do not launch
a paid scrape merely to test connectivity. The snapshot includes
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
posters. Preserve all known deferred initial failures; do not investigate or
backfill them in this task. These rules are unchanged.

### Flyer-first visual review (high priority)

**Finding and preserving the actual event flyer is a primary deliverable, not
an optional enhancement.** For each NEW potentially relevant Instagram post,
review its caption AND every available carousel slide, including posts without
event keywords, before deciding that no usable flyer exists. Prioritize
retrieving a legible, event-specific flyer over writing descriptions or polishing
lower-priority findings. Do not mistake a post's generic cover, venue photo or
artist portrait for an event flyer.

**Videos and Reels require an active flyer search.** Do not stop at the cover
image or caption. First inspect available thumbnails/preview images. When the
video itself is accessible through existing free source media, sample frames
at representative points across the clip (and around any transitions or
visible flyer segments), then inspect promising frames at full resolution.
Use a clean, legible still with the event's actual graphic, date and lineup
when available, not a blurred transition or an Instagram UI screenshot.
Extract the original frame as a JPEG/PNG where feasible; never invent,
reconstruct or AI-generate a missing flyer. A still frame from an event
promotion video counts as a valid event flyer when readable and accurate.
Do not imply that sampled frames constitute a complete video/audio review.

For each new event, search for usable artwork in this order: (1) the actual
flyer in the post's images/carousel; (2) a legible frame in the post's
video/Reel; (3) an event-specific flyer at its verified linked source or
venue page. Use only already collected content and free public retrieval;
do not expand the paid scraper, refresh the fixed roster, or exceed the
$0.59 daily cap. Use contact sheets to triage images or frames and inspect
the strongest candidates individually. Prefer a full-resolution image over
a thumbnail whenever available.

**Do not count a flyer as captured until it has a usable image URL and its
preservation has succeeded through QDP's restricted flyers operation.**
The current operation takes an HTTPS image URL, not a video or local image
file. For video stills, use a verified direct image URL if one is available.
If a locally extracted frame has no approved URL/upload path, do not pass a
video URL, placeholder, fabricated URL, or unauthorized storage link as
RawFlyerURL. Keep the event as waiting, record "flyer visible in video;
extracted frame cannot yet be saved" distinctly from "no flyer found",
and report this technical gap. Do not seek direct Google or Cloudflare
account access as a workaround.

Before marking any NEW post screened, complete and record its flyer search
outcome (saved, no usable flyer, video frame found but unsavable, or media
unavailable). Distinguish images downloaded, slides inspected, videos
sampled, frames inspected, flyers verified, flyers actually saved, and
unavailable media. Per-profile collection success is not full visual
coverage.

Use tools/discovery/collect-venues.py for the existing free Val's, Dolphin Tavern,
and Warehouse on Watts checks, plus the existing public discovery searches.
Verify source details and named edition-specific performers. All Philadelphia
DJ-centered dance parties qualify regardless of genre or queer identity; queer,
sapphic and trans relevance affects ranking only. Exclude NOTO and The Ave Live/
The Ave from discovery. Rank today, tomorrow, next seven days, days 8–14, then later
findings, chronologically. Keep unresolved/missing-lineup leads as waiting records.
New recommendations require a confirmed named lineup and a usable flyer.

## Review and delivery

Write engaging, lively promotional descriptions that make events appealing.
Use vivid, natural, event-specific promotional copy grounded in verified
information. Do not invent facts, atmosphere, performers, identities,
restrictions, or unsupported details. Avoid dry, list-like descriptions.
No URLs or process/evidence notes in Description. Preserve verified hours; assume only missing boundaries (10 PM /
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

Preserve each chosen flyer for ready candidates with the restricted flyers
operation (up to three per call) **before** staging; write the returned,
confirmed public Drive image URL to Flyer_URL. Reuse that saved URL on future
runs. Give flyer preservation priority over optional write-up improvements.
Only report a candidate as flyer-ready after a successful save. If video
artwork was identified but no saveable image URL exists, record a waiting
lead with the precise limitation rather than silently omitting the flyer.
Missing/unavailable media remains an honest coverage gap; do not copy every
scraped image into Drive.

Save screening markers with screened-posts (up to thirty per request), progress
with run.save, and the checkpoint with its exact current version. Read/reconcile
a version conflict; never force over a newer checkpoint. Keep activeRun until all
review/progress/delivery writes are confirmed. Record actual coverage and counts.

Return the verified Admin inbox link, concise new/updated/waiting/correction counts,
actor charges or clearly labeled unknown reservations, and material gaps.
Include **flyer coverage**: new events with saved flyers, video/Reels examined,
flyers captured from video, video flyers identified but unable to be saved,
and genuinely missing/unavailable artwork. Do not inflate "captured" by
counting a video frame that was only inspected. Include verified venue/policy
news and independent QDP/Callaia/Melt mentions separately.
No workbook generation is required; use Admin Download Excel when requested.

## Owner import

The signed-in owner edits proposals and saves Include / Wait / Exclude. Add selected
to QDP processes up to five proposals per request and starts immediately. It saves
flyers, matches IDs, writes Events, creates Calendar entries with stable retry IDs,
and refreshes public data once after the selection. Per-item failures retain their
progress and can be retried. Initial rows stay unpublished until Calendar creation
is confirmed. Existing Push/Pull remain direct. Archive Review is separate.

## Delivery integrity and review boundaries

Return the confirmed Admin inbox link with new, updated, waiting, correction,
and coverage counts; confirmed actor charges or clearly labeled retained/unknown
reservations; and material limitations. Never fabricate successful reviews,
public matching, image inspection, imports, publication, or complete account
coverage. Preserve user edits, Include/Wait/Exclude decisions, and import receipts.
Save progress and checkpoints promptly with version checks. Excel is optional via
Admin export; do not build the old cumulative workbook. Do not automatically
import, create Calendar entries, Pull, publish, or send external messages.
Do not change code, infrastructure, access policies, credentials, billing,
triggers, or schedules during a discovery review.
