# Install the archive feed in the existing QDP Apps Script project

This folder contains the archive feed and prepared-data publisher for the
existing v6.3 Apps Script project.
The branch does not contain the full Apps Script, spreadsheet ID, sheet data,
or script properties. The existing public Web app already serves the archive.

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
     'archiveartists', 'archivevenues', 'archivemonths',
     'archiveartist', 'archivevenue', 'archivemonth'
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

The extension reads `Artists`, `Venues`, `Archive 2024`, `Archive 2025`,
`Events_Archive`, and published rows of `Events`. It does not modify any sheet
or Calendar entry. The publisher writes approved public fields to the
configured Cloudflare KV namespace.

- Artist and venue profiles require `Public_OK=Yes`. The temporary artist
  setting you made meets this gate. A nonpublic venue's address and profile
  are never returned.
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
public gates, and writes 13 grouped records to Cloudflare KV. It writes no
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
   If the record is missing or older than six minutes, the endpoint uses its
   existing five-minute cached Google path and marks it `HIT` or `MISS`.
4. After reviewing the preview, bring the speed changes to `main`. In the
   `qdp` Pages project's **Production** environment, bind the **same** KV
   namespace under `QDP_PUBLIC_FEED_KV`, then redeploy production. The
   production function reads only the `qdp-live:v1:feed` record. Until both
   the code and production binding are present, the live site remains on the
   old feed path.

The prepared feed is refreshed every five minutes. Cloudflare's local KV
copies and the browser can add roughly another minute before a visitor sees a
change. A missed trigger or stale record switches back to the current Google
path. The trigger consumes Apps Script execution time and writes one KV record
per run (about 288 per day); check your Apps Script executions and Cloudflare
plan's daily limits after enabling it.
