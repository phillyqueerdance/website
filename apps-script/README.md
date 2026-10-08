# QDP public-data publisher, event pages, and profiles

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
