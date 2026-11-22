# QDP public-data publisher, event pages, and profiles

## Automatic discovery feedback through Apps Script (v7.4.29)

The supplied complete **Core.gs v7.4.29** records Admin review choices in a
`QDP_Discovery_Decisions` ledger. Confirmed event/correction intake saves create
Include receipts in the same backend. The review reads a dedicated, read-only
Apps Script POST endpoint, follows complete revision-checked snapshots and caches
the result in its private state. No Cloudflare account, KV binding or API token
is needed for feedback or the discovery run.

Replace Core.gs, then update its existing web-app deployment without changing
its URL/access or other scripts/triggers. Run `qdpSetupDiscoveryFeedback` in the
bound spreadsheet to create the ledger and obtain the private read-only
connection. Configure `daily_discovery.appsScriptFeedback` in the existing
review state. Existing read tokens are preserved. No ongoing export is required.
See [DAILY-DISCOVERY.md](../DAILY-DISCOVERY.md) for the full activation/run steps.

[DiscoveryDecisions.gs](DiscoveryDecisions.gs) is the testable source reference;
its functions are **already embedded** in the separately supplied full Core.gs.
Do not also install it. The complete source delta is
[discovery-feedback.patch](discovery-feedback.patch). The existing website's
hosting and Admin login are unaffected; no Cloudflare settings need changing.

## Combined daily discovery and lineup corrections (v7.4.28)

The Apify Import page now saves Include / Wait / Exclude decisions across daily
workbooks. See [DAILY-DISCOVERY.md](../DAILY-DISCOVERY.md) for collection limits,
the cumulative backlog, the protected feedback feed and the unchanged public
calendar comparison. The normal existing import action remains in use.

Replace the separately supplied **Core.gs** with v7.4.28 and update the existing
web-app deployment to activate the new selectable **Lineup** correction field.
The precise delta is [apify-lineup-corrections.patch](apify-lineup-corrections.patch).
Keep every other bound script, property, permission, URL and trigger. No setup
rerun, general lineup backfill or extra reconciliation job is introduced.

## Admin Push and Pull without a queue (v7.4.27)

Replace the separately supplied **Core.gs** with v7.4.27, save, and update the
existing Apps Script web-app deployment to a new version. Keep its URL and
access settings. No setup rerun or trigger installation is required.

Admin Push and Pull now execute in the request that starts them. The page shows
**running**, then completion or the returned error; keep it open until the
operation finishes. A successful response includes the refreshed event list
and Last Push/Last Pull status. The spreadsheet menu continues to run directly.
The shared write lock still prevents simultaneous writes and names the active
operation when it blocks another action.

Old queued sync records no longer block saves. On the first direct sync, any
remaining scheduled Admin sync triggers and their old queue record are removed.
The retired trigger handler only cleans up; it never replays the old sync.
Other scheduled tasks are preserved. Admin asks for the updated Core when it
detects an older deployment, instead of submitting another queued operation.

Validation: `QDP_CORE_SOURCE=/path/to/Core.gs node --test
tests/admin-sync.test.mjs tests/admin-bulk.test.mjs tests/admin-bulk-api.test.mjs`.

## Admin Archive Backfill (2025 pilot)

**Flyer approval fix (v1.1.1).** Replace ArchiveBackfill.gs and update the existing
web-app deployment. Older archive tabs receive a flyer column when an approved
edit is saved. The review previews that field immediately and explains any
remaining reason a flyer approval is unavailable.

**Batch review (v1.1.0).** Replace ArchiveBackfill.gs and update the existing
web-app deployment. Core.gs v7.4.26 remains compatible. The review loads
suggested records together, then filters and pages locally.

The new `/admin/archive-backfill` page reviews externally collected historical
Instagram evidence beside existing archive events. Install the separately supplied
**Core.gs v7.4.26**, add **ArchiveBackfill.gs** to the existing Apps Script project,
and update its existing web-app deployment. Keep ArchiveReview.gs v7.4.25,
PublicData.gs v7.4.22+, Imports.gs, the Apify flyer importer, properties,
permissions, deployment URL and existing triggers. No setup rerun is required.

Import `QDP_2025_Backfill_Review.json` on that page. Source records upload in
compressed batches of up to 500. **Resume import** continues an interrupted
import from the last completed batch. Selecting the same original JSON again
reuses records and reviews that are already saved. The Index retains source
identities, media, choices, coverage and update history in Backfill_Posts,
Backfill_Review, Backfill_Runs and Backfill_History. Original scraper records
are saved in Drive.

Two queues distinguish existing archive matches from possible additions. A lead
without a match is not proof that the archive is missing an event. The first
version retains addition leads for later review; it does not create historical
events. Search checks proposal details and supporting account names/captions.

Matches require a full event date and additional evidence, or an existing source
link. Admin uses the current shared alias rules, including historical artist
names. One source can support several dates, and several posts can support the
same proposed event. The carousel retains the source slide order.

Compare the source with the suggested archive event. **Approve match + flyer**
queues that update in one click. Choose another match, check further fields,
defer or reject a proposal as needed. **Save all changes** saves the queue across
pages. Each batch rechecks the review, Index and archive revisions and commits
valid edits with their before/after history. Rows that need attention stay queued
with an explanation. Publish separately in Archive Updates.

**Descriptions:** collection imports must leave Description blank. Confirming a
match and selecting Update description creates a saved writing request. Download
selected requests and return them to ChatGPT for writing; import the resulting
JSON drafts and review them beside the current copy before applying. Draft items
use `key`, `expectedRevision` and `description`. No model API key is required.

**Flyers.** Selected images download together during the batch save. Under
**Use downloaded source images**, choose an extracted source folder to preview
and use the originals for matching filenames. You can also pick the original
for an individual slide. The save verifies the collected hash for an original
and verifies the stored copy. Individual images can be up to 6 MB.

The preparation tools under `tools/backfill/` accept the source-directory path
as their first argument. They preserve the intake's 43-column order. OCR is a
text extraction aid; source image inspection and user approval remain distinct.
Do not describe OCR output as visually confirmed event facts. Unknown times
remain empty historical proposals so they cannot replace recorded times with
guesses. Use the current future-event intake for its usual assumed-time rules.

Validation: run the archive, backfill, UI, upload and Admin proxy tests with
`QDP_CORE_SOURCE` set to the supplied Core.gs path. Live Apps Script/Drive
installation still requires verification in the user's existing deployment.

## Admin Archive Updates

**Search and collective aliases (v7.4.25):** Replace **Core.gs** and
**ArchiveReview.gs** with the complete supplied v7.4.25 scripts, then update the
existing Apps Script web-app deployment. Keep Imports.gs v7.4.24 and the other
installed scripts. No setup rerun or new scan is needed for search.

The top search field searches saved records in `Events_Archive` and every
`Archive YYYY` tab, including events with no review suggestions. It matches
text in event fields and linked profile names, ignores case and accents, and
shows 20 editable results per page, newest first. Scan dates, profile filters,
and review status filters do not restrict this search. Clearing it returns to
scan suggestions; unsaved edits and decisions survive searches and pagination.
Matching uses saved sheet data, so local drafts affect the matches after saving.
Current Events records remain part of scans when selected; master search covers
archived records only.

`Collectives.CollAliases` accepts comma-separated aliases and the existing
`[exact-only phrase]` syntax. Core's shared matcher uses both `CollAliases` and
any existing `Aliases` entries, so Calendar pulls, sheet ID detection, imports,
and archive review use the same collective aliases. Existing manual selections
and saved rejections still take precedence. New alias matches are picked up on
the next pull or ID scan, rather than overwriting every historical row on
installation. The collective profile editor exposes the new column when it
exists. Editing the aliases invalidates approvals based on an older Index.

The Admin dashboard links to `/admin/archive-updates`. It scans events already
recorded in `Events_Archive`, every `Archive YYYY` tab, and optionally the active
`Events` tab. Date ranges and artist, venue, party, or collective filters can
focus a scan on one profile or type. It does not import external historical
events or perform an Instagram scrape.

The full Core.gs replacement is supplied separately because it is maintained
with the user's existing Apps Script source. Keep PublicData.gs v7.4.22,
ApifyAdminImport.gs, scraper.gs, the manifest, Script Properties, and refresh
triggers. `archive-feed.gs` remains a reference publisher and must not be
installed alongside PublicData.gs. Preserve the existing deployment URL and
access settings when creating the new deployment version.

Each result includes an inline event editor. The title and complete description
are directly editable; **Edit IDs and other event details** opens association
pickers, dates, venue, links, visibility, and other available fields. Artist and
collective pickers search the Index, including associations the scanner missed.
Calculated fields stay protected. Source records are resolved by sheet and
EventID, so moving rows does not direct an edit to a different event.

Scan and check the revisions to approve; suggestions begin unchecked. Event
edits, choices, and rejections stay local across result pages until **Save all
changes**. That action validates every direct edit first, commits event edits,
review decisions, and permanent rejects in one Sheets request, then applies
remaining approved revisions in batches. Checked additions on a directly edited
event are merged into that same commit. Conflicting single-value choices or a
stale edited event stop the whole submitted edit/decision batch before writes.
The rejection ledger and the review
status are written atomically without depending on a potentially cached reread.
The page can restore saved rejected matches for a later scan. **Start new scan**
always replaces the current review and unsaved choices while retaining saved
rejects and already applied source edits.

After an event is edited, its remaining unapproved suggestions require a fresh
scan because their evidence may have changed. The inline editor remains usable.
A new scan also discards unsaved event edits. Formula expressions are protected
and checked for changes; recalculated values alone do not make an edit stale.

**Publish saved changes** is separate. Saved source edits set a publication
hold respected by scheduled publishers and public fallback responses. Until
explicit publication completes, the website uses its published snapshots;
the live timer only keeps that existing snapshot fresh. The hold survives
page closure, fresh scans, and publishing failures. Rejection-only saves do
not need publication.

Archive matching shares Core's alias rules, normalization, and artist name
exclusions. It preserves existing single venue/party assignments and existing
list IDs. Profile affiliations do not supply event lineups or event venues.
Changes to source records or lookup data block stale approvals. Active event
changes receive the ordinary edit timestamp for Calendar sync; archived events
remain in their source archive sheets. Publication keeps the existing public
profile approvals, event visibility, cancellation, and identity consent gates.

Review decisions use `Archive_ID_Review`. Durable scan and job progress live in
Script Properties under `QDP_ARCHIVE_ID_REVIEW_SCAN_V1` and
`QDP_ARCHIVE_ADMIN_*`. While the page is open it advances batches immediately.
One temporary `qdpArchiveAdminWorker` minute trigger continues an active job
after the page closes, and removes itself when the job completes or fails.
Failed operations display their error and can be retried; applied changes keep
a publication marker until both the live feed and archive are published.

Scans process up to 1,000 records or 15 seconds of matching per batch, reuse
lookup reads within each execution, and append without downloading the growing
review. Progress responses omit result cards until a batch operation finishes.
Result pagination hashes only the displayed proposals. Applying revisions reads
only the affected source tabs and checks affected row spans together. Main
Admin bootstraps use one Apps Script request with the updated Core, and refreshes
retain unchanged event cards. Older Core deployments retain their venue-list
compatibility request.

Inline editor data reuses one source-table read and one formula read per source
tab on the displayed page. Multi-event saves recheck affected spans together.
Profile options are created when a picker is opened, with search results capped
to avoid rendering the entire artist catalog for every result card.

Validation: set `QDP_CORE_SOURCE` to the supplied Core.gs path and run
`node --test tests/archive-updates.test.mjs tests/archive-review-ui.test.mjs`.
The archive integration checks use Core's real shared save rules and skip with
an explicit reason when its separately maintained source is unavailable.
Browser layout and interaction checks use isolated example records rather than
changing the live archive.

## Event photos

Add an optional `PhotoURLs` column anywhere in the Events tab. Put the image
links for that event in the same cell, one link per line. Their order becomes
the gallery order; blank lines, repeated links, and invalid URLs are ignored.
Public Google Drive file links use the existing flyer image conversion.
For older events, the same column is supported on the event's archive source tab.

Replace only **PublicData.gs** with v7.4.3. Keep Core.gs, Imports.gs,
ArchiveReview.gs, properties, and triggers. Save and update the existing Web
app deployment to a new version, retaining its URL and access settings. Use
**QDP > Public data / Website > Publish all website changes now** to refresh the
current feed and archive. The repository `archive-feed.gs` is a tested reference
helper; do not install it beside PublicData.gs.

Any event strip with photos expands into a gallery with **Go to event** beneath
it, on the calendar and all artist, party, venue, collective, and archive pages.
One event is expanded at a time. Galleries show one complete photo at a time;
their arrows, keyboard navigation, and mobile swipes wrap in both directions.
Archive dropdowns extend beneath the purple date column and have two rounded
bottom corners, with no top border. Every individual event page with photos
displays the same carousel below its description. Photos also open in a larger
viewer. Blank PhotoURLs cells retain the existing event layout.
The normal event publication gates and artist flags continue to apply.

## Artist and party profile images

The site reads `ArtistImage_URL` from approved Artists rows and `PartyImage_URL`
from approved Parties rows. On desktop and mobile, the image sits directly beneath the name
header inside the frame, with matching width and side borders. Queer profiles
use purple headers and photo frames; other profiles use red. The portrait's bottom
corners match the header's curves. It scrolls into the header like a closing
drawer; the description, links, related profiles, and events follow below.
Profile descriptions are displayed in full, without a character cutoff.
Drive URLs use the same browser image conversion as event flyers. Desktop
Discover uses compact vertical tabs with an attached name tab beneath the active
artist, venue, party, or collective category. The name tab shares the header's
right edge and leaves a small gap on the left. These name tabs appear only on
desktop. Descriptions, related profiles, and external links for all four profile
types appear inside the main frame above their events on desktop and mobile.

Install Core.gs v7.4.8 and PublicData.gs v7.4.4 in the existing Apps Script
project. Reload the Index, then use **QDP > Update Artist Image URLs (from
Raw_ArtistImage_URL)** or **QDP > Update Party Image URLs (from
Raw_PartyImage_URL)** to convert Drive file share links into the corresponding
image column. The action writes destination cells only for valid, changed links.
Column order does not matter.

Use **QDP > Public data / Website > Publish archive changes** to publish the
photos. Images must be viewable without signing in. The raw column is never
published. To remove a photo, clear both image columns and publish again.
The temporary Callaia image remains only for older feeds that do not yet
include the new image field. The repository `archive-feed.gs` remains a
reference helper, not an additional file to install beside PublicData.gs.

## Venue photos in Discover

Use `VenueImage_URL` for published venue photos and `Raw_VenueImage_URL` for
Drive share links. Core.gs v7.4.9 adds **QDP > Update Venue Image URLs (from
Raw_VenueImage_URL)** and uses the renamed column for the existing Places tools.
PublicData.gs v7.4.5 publishes the image URLs of approved venues. After saving
both files, reload the Index, convert any raw links, and choose
**QDP > Public data / Website > Publish archive changes**. Venue profiles,
Venue strips, and the Discovery Map use the published image URLs.

## Current production update: v7.2

For the existing four-file v7.1 project, replace **only PublicData.gs** with
the supplied v7.2 file. Keep Core.gs, Imports.gs, ArchiveReview.gs, the
manifest, properties, Web app URL, and existing triggers. Save, then use
**QDP > Public data / Website > Publish archive changes**. Do not install
`archive-feed.gs` alongside PublicData.gs; this repository helper documents
and tests the same publishing protocol for the older project layout.

The first successful v7.2 archive publish migrates all 27 data records and
the manifest. Later publishes write only changed data records and publish the
manifest last. Each manifest has `recordIndexVersion: 1` and a
`recordRevisions` map of content versions. The private Script Property
`QDP_ARCHIVE_RECORD_REVISIONS` remembers successful versions for the configured
account and namespace. Unchanged runs cost zero writes; a changed manifest
with no changed data records costs one write. Logs include `recordCount`,
`skippedRecordCount`, and `kvWriteCount` (including the manifest). The existing
force-publish menu action rebuilds all records after a reset. Failed writes do
not advance the local ledger or whole-snapshot fingerprint.

Production uses the existing `QDP_PUBLIC_FEED_KV` binding. Preview can keep
`QDP_ARCHIVE_KV`. No new namespace, token, binding, or trigger is required.
Website readers accept both the original global-revision format and the new
per-record format, so deploy the website before running the v7.2 publisher.

Calendar HTML and API responses share a cached live record for at most 30
seconds. Profile, event, related-link, and sitemap readers share the manifest
for at most 60 seconds and share version-validated archive records for up to
one hour. Every new response expires by its source manifest/live deadline;
these cache layers do not add another 30 or 60 seconds to publication changes.
Identical reads within a request or concurrent requests in one worker are
coalesced. Missing, invalid, or mismatched records are not retained between
requests. Existing publication gates, propagation fallback, and refresh
trigger timing remain in effect.

The sections below are historical installation notes for the earlier preview
and standalone helper. They are not additional setup steps for v7.2.

This folder contains the archive feed and prepared-data publisher for the
existing v6.3 Apps Script project.
The branch does not contain the full Apps Script, spreadsheet ID, sheet data,
or script properties. The existing public Web app already serves the archive.


## Permanent event links and Google event markup

The October 7 update keeps each public EventID at `/?event=EVENT-ID` after it
leaves the current calendar. Cloudflare renders the selected event, metadata,
and eligible Event JSON-LD in the initial HTML. Archive context URLs keep their
Back destination and canonicalize to the same standalone event URL. Shared
links and Google Calendar drafts use the standalone URL.

For the existing configured Apps Script project:

1. Replace the **existing archive helper file** with the current
   [`archive-feed.gs`](archive-feed.gs), keeping one copy of each helper. Keep
   the existing master script, `doGet`, deployment URL, script properties,
   publication approvals, and refresh triggers. All four profile tabs require
   `Public_OK`; this update preserves the party gate and public identity flags.
   It also preserves the direct profile relationship columns `Artist_Collectives`,
   `Artist_Parties`, `PartyArtists`, `PartyColls`, `CollArtists`, and `CollParty`.
   These links use approved IDs in either direction and do not infer ownership
   or membership from event history. Keep any existing separate enrichment
   helpers only once; the publisher now includes this relationship handling.
2. Save and run `qdpArchiveForcePublish` once. It publishes the permanent event
   index plus the normal directories and profiles. The log should report
   `recordCount: 27` and `eventCount`. The manifest now declares
   `eventIndexVersion: 1` and eight event shards. Then run `qdpLivePublish` to
   refresh the current calendar. The existing fifteen-minute archive trigger
   and five-minute live trigger continue to work; no additional trigger is
   needed. Install those triggers only if the project does not already have them.
3. Update the **existing Web app deployment** to a new version of the saved
   code so the archive live fallback uses the same gates and month logic. Keep
   its current access settings and URL. No new project, token, or KV binding is
   needed for the preview.
4. On the Massive preview, verify a past and an upcoming `/?event=...` page.
   Their response header should become `X-QDP-Event: INDEXED`; `/api/event`
   should return the selected event, and `/sitemap.xml` should include its
   canonical URL. Current-month ended events also enter the month archive,
   including those still on the active Events sheet.
5. Run Google's Rich Results Test on an **individual event URL** or its HTML.
   A calendar containing many events is not the target for Event rich results.
   Event markup requires a publicly disclosed venue and address. Pages with an
   undisclosed or incomplete location stay readable and retain their permanent
   links, but omit Event markup instead of disclosing or inventing an address.

Before this publisher update is installed, the preview can resolve the
already-published archive and current feed through a compatibility path. It
cannot establish the existence of recently ended rows that have not yet been
archived; those requests return a temporary 503 rather than erase the link.
Mixed KV revisions likewise return 503 until propagation finishes. After the
new index is published, a known absent event returns 404; an unpublished active
row overrides an older archived copy with the same ID.

The Massive preview retains `noindex`. Google indexing starts only after a
separate production rollout: merge the reviewed changes, bind the public-data
namespace under `QDP_PUBLIC_FEED_KV` (the event resolver reads the archive index
as well as the live record), verify production event responses have no
`noindex`, and submit `https://queerdancephilly.com/sitemap.xml` in Search
Console. Valid markup makes an event eligible; Google decides whether to index
it or display a rich result. Main and production are not changed by the preview
commit.

## Profile pages and canonical URLs

Individual artist, venue, party, and collective URLs now include their approved
name, bio, public links, and event history in the initial HTML. Each has its own
title, description, and canonical URL, for example
`https://queerdancephilly.com/?archive=artist&id=ARTIST-ID`. Extra query parameters
do not change that canonical. An event opened from a profile still canonicalizes
to its standalone event URL; closing it restores the profile metadata.

The sitemap includes all four sets of approved profile IDs from the existing
public archive manifest, with the party approval gate preserved. Removed IDs
return 404; temporary data failures return 503 and are not cached. Profile HTML
and API responses share the existing sixty-second cache policy. The browser
uses the embedded profile payload on first load instead of requesting it twice.

This profile update uses the existing prepared archive and does not require an
Apps Script replacement, a new namespace, or a new trigger. The archive reader,
event reader, and sitemap all accept `QDP_ARCHIVE_KV` or `QDP_PUBLIC_FEED_KV`.
Massive remains `noindex`; ordinary Google search indexing becomes possible
after the separate production rollout described above. These directory profiles
are not promised a Google profile rich result.


The numbered steps below document the original feed installation. **For the
speed update, leave the existing `doGet` alone and follow “Prepared archive
for faster preview loads” below.**

1. In the **existing** QDP Apps Script project, keep the archive helpers you
   already added from [`archive-feed.gs`](archive-feed.gs). They can be in
   `Code.gs` or a separate `.gs` file within that same project; both run as
   part of the same Web app.
2. In the existing `doGet(e)`, **before** the line
   `if (resource && resource !== "events") {`, add this dispatch:

   ```javascript
   if ([
     'archiveartists', 'archivevenues', 'archiveparties',
     'archivecollectives', 'archivemonths', 'archiveartist',
     'archivevenue', 'archiveparty', 'archivecollective', 'archivemonth'
   ].includes(resource)) {
     return respond(qdpArchiveResource_(resource, e && e.parameter));
   }
   ```

   The existing `doGet` already lowercases `resource`. Leave its `events`
   response, error handling, and `doPost` unchanged. Do **not** add a second
   `doGet` function.
3. Save the script. The `qdpArchivePreviewCheck` counts already look good.
   Deploy a new version of the **existing** Web app after updating `doGet`.
   The preview site's `/api/archive` calls that same deployment URL. No new
   Apps Script project, deployment, token, or Cloudflare variable is needed.

If you previously added the token-checking dispatch from this branch, replace
that whole `if ([...].includes(resource))` block with the block above before
redeploying. The helper file you already added can remain in the project.

## Publication gates

The extension reads `Artists`, `Venues`, `Parties`, `Collectives`, `Archive 2024`, `Archive 2025`,
`Events_Archive`, and published rows of `Events`. It does not modify any sheet
or Calendar entry. The publisher writes approved public fields to the
configured Cloudflare KV namespace.

- Artist, venue, party, and collective profiles require `Public_OK=Yes`. A
  nonpublic venue's address or a private profile's fields and ID are excluded.
  A missing `Public_OK` header stops the publisher before any KV write.
- **Every event row** requires `Publish_To_Web=Yes`, including legacy archive
  tabs. If a tab has no `Publish_To_Web` header, all its rows are excluded.
  This is the sheet preparation needed to make legacy events appear. Review
  those rows before marking them Yes, particularly DIY or undisclosed venues.
- Deleted, cancelled, draft, private, or rejected statuses are excluded.
  Identity indicators use the script's existing `PublicIdentity_Consent` check.
- The response contains selected public fields only. The Pages function
  applies a second public check before returning data to the browser.

The existing Apps Script Web app and `massive` Pages preview are public. These
approved fields are retrievable from both; `noindex` is not access control.
This branch does not change the Apps Script deployment itself.

## Prepared archive for faster preview loads

The updated `archive-feed.gs` also contains a publisher in **the same Apps
Script project**. Replace the previous archive helpers with this updated file;
do not paste a second copy of the functions. The existing `doGet` dispatch
above remains the same. The publisher reads the sheets, applies the same
public gates, and writes 27 grouped records to Cloudflare KV in request-size-limited batches. It writes no
sheet cells, Calendar entries, or public data into GitHub.

1. In Cloudflare, create a Workers KV namespace named `qdp-archive-preview`.
   In the `qdp` Pages project's **Preview** environment, add a KV binding
   with variable name `QDP_ARCHIVE_KV` pointing to that namespace. Leave the
   Production environment unbound. Redeploy the `massive` preview after adding
   the binding.
2. Create a Cloudflare API token scoped to this account with **Workers KV
   Storage Write** permission. In the **existing** Apps Script project,
   Settings > Script properties, add:

   | Property | Value |
   | --- | --- |
   | `QDP_ARCHIVE_CF_ACCOUNT_ID` | Cloudflare account ID (32 hex characters) |
   | `QDP_ARCHIVE_CF_NAMESPACE_ID` | ID of `qdp-archive-preview` |
   | `QDP_ARCHIVE_CF_API_TOKEN` | The private write token |

   Do not put the token in this repository or the site's browser code.
3. In the Apps Script editor, run `qdpArchivePublish` once and check that its
   log reports about 230 artists, 130 venues, 23 months, and 3,849 archived
   events. Then run `qdpArchiveInstallRefreshTrigger` once. The scheduled run
   checks for changes every 15 minutes and skips the Cloudflare write when
   the public data has not changed. Changes made by Pull/Push are picked up
   on the next check; to publish immediately after a review batch, run
   `qdpArchivePublish` again. If the namespace is reset without a Sheet edit,
   run `qdpArchiveForcePublish`.

   If Apps Script reports `Address unavailable` during a bulk write, replace
   the helper with the current version and run `qdpArchivePublish` again. It
   retries temporary connection failures and sends smaller bulk requests.
   The manifest is updated only after every batch is confirmed; a failed run
   can be retried with the same function. No new token is needed.
4. Load `https://massive.qdp-ali.pages.dev/api/archive?resource=artists` and
   check the response header `X-QDP-Archive-Source: prepared` in browser dev
   tools. Test an artist, venue, and month view on the preview. If the binding
   or data is missing, the existing live Apps Script feed still works, but
   will remain slower. No main-branch deploy is needed for this preview.

The site will still fetch profiles and months at their existing URLs and use
the same popup and navigation. Until a successful publish, or briefly while
Cloudflare's locations receive an update, a request uses the live feed. A
removed profile is excluded by the new manifest. Refresh the browser page to
see new data; the current page keeps loaded archive views in memory.

## Parties and Collectives in the preview

1. Replace the archive helper code in your **existing** Apps Script project
   with the updated `archive-feed.gs`. Keep one copy of each function. Add
   `archiveparties`, `archivecollectives`, `archiveparty`, and
   `archivecollective` to your existing `doGet` dispatch as shown above,
   then save and redeploy that Web app. This keeps the live fallback working
   if a prepared record is temporarily unavailable.
2. In the `Collectives` sheet, mark each collective you want public with
   `Public_OK=Yes`. Rows left blank or marked No stay private. The `Parties`
   sheet also requires `Public_OK=Yes`; its approved `PartyName`, `PartyDesc`,
   and `PartyInsta` fields are public.
3. Run `qdpArchivePublish` in the Apps Script editor. The existing archive
   trigger will then keep Parties and Collectives current with the other
   directories and events. The log now includes `partyCount` and
   `collectiveCount`. No new token or Cloudflare binding is needed.
4. Open the branch preview's `/?archive=parties` and
   `/?archive=collectives` pages. Individual party pages use published
   events' `PartyID`. Collective pages use published events'
   `HostCollectiveIDs` and public party links from `PartyColls` or
   `CollParty`, so events for a collective's party also appear there.

## Prepared live listings for first-time visitors

The public calendar used to send an empty poster to new visitors and wait for
`/api/events` before drawing a single card. A fast API still left that extra
request in the first-page path. The preview's home page now reads the prepared
feed and includes the current public cards and event links in its HTML. Its
JavaScript enables the poster controls and refreshes in the background. The
page uses the existing client-side feed as a fallback if no fresh record exists.

The current five-minute API cache can miss at a Cloudflare location and make
that visitor wait for Google during fallback.
The updated helper file adds `qdpLivePublish` to this **same Apps Script
project**. It calls the existing public `doGet({ resource: 'events' })` directly,
keeps only the current public response fields, and writes one `qdp-live:v1:feed`
record to the **existing** KV namespace. No new token or `doGet` dispatch is
needed.

1. Replace the archive helper code in your existing Apps Script project with
   the updated [`archive-feed.gs`](archive-feed.gs). Save it; do not keep two
   copies of the functions.
2. Run `qdpLivePublish` once in the Apps Script editor. Check that its log says
   `liveEventCount` and a recent `publishedAt`. Then run
   `qdpLiveInstallRefreshTrigger` once. It adds one five-minute trigger and is
   safe to run again without creating duplicates. Keep the archive's existing
   fifteen-minute trigger. If a listing must disappear urgently, run
   `qdpLivePublish` after changing its publication status.
3. The `massive` preview already has `QDP_ARCHIVE_KV` in the **Preview**
   environment, so after the new branch deployment its `/api/events` response
   should have `X-QDP-Cache: PREPARED`. The home page's HTML response should
   have `X-QDP-Initial-Events: PREPARED`, and its page source should contain
   event cards inside `id="eventStack"`. Test a fresh private window and an
   archive link.
   If the record is missing or older than sixteen minutes, the endpoint uses its
   live Google path and marks it `HIT` or `MISS`.
4. After reviewing the preview, bring the speed changes to `main`. In the
   `qdp` Pages project's **Production** environment, bind the **same** KV
   namespace under `QDP_PUBLIC_FEED_KV`, then redeploy production. The
   production event pages and sitemap also read the public archive manifest
   and event shards. Until both
   the code and production binding are present, the live site remains on the
   old feed path.

The trigger still checks for edits every five minutes. An edited feed is written
on that run; an unchanged feed receives a heartbeat write after ten minutes,
roughly halving its KV writes. Cloudflare's edge cache adds at most thirty
seconds per location, and a long-open Discover tab rechecks its current view
after sixty seconds when revisited. A missing or stale live record switches
back to the Google path. Install the updated `archive-feed.gs` in the existing
Apps Script project to activate the reduced-write publisher; the deployed
website caching changes work independently until that replacement is saved.

