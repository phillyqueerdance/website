# Install the archive feed in the existing QDP Apps Script project

This folder contains a read-only extension based on the supplied v6.3 script.
It is **not deployed** and this branch does not contain the full Apps Script,
spreadsheet ID, sheet data, or script properties.

1. In the **existing** QDP Apps Script project, add a new script file named
   `archive-feed.gs` and paste the contents of this folder's
   [`archive-feed.gs`](archive-feed.gs). Do not create a second Apps Script
   project.
2. In the existing `doGet(e)`, **before** the line
   `if (resource && resource !== "events") {`, add this dispatch:

   ```javascript
   if ([
     'archiveartists', 'archivevenues', 'archivemonths',
     'archiveartist', 'archivevenue', 'archivemonth'
   ].includes(resource)) {
     if (!qdpFlyerSafeEqual_(
       e && e.parameter && e.parameter.archiveToken,
       getProp_('QDP_ARCHIVE_READ_TOKEN')
     )) return respond({ error: 'Archive access denied.' });
     return respond(qdpArchiveResource_(resource, e && e.parameter));
   }
   ```

   The existing `doGet` already lowercases `resource`. Leave its `events`
   response, error handling, and `doPost` unchanged. Do **not** add a second
   `doGet` function.
3. Save the script. When you are ready to test against the live spreadsheet,
   run `qdpArchivePreviewCheck` from the Apps Script editor and read the four
   counts in the execution log. Then, when you want the data accessible, deploy
   a new version of the existing Web app. The website's `/api/archive` will
   call that same deployment URL.

Before deploying, set a long random `QDP_ARCHIVE_READ_TOKEN` in the existing
Apps Script project's **Script Properties** and the same value as the
`QDP_ARCHIVE_READ_TOKEN` secret in the Pages **preview environment**. Set
`QDP_ARCHIVE_ENABLED=yes` only in that preview environment after protecting
its Pages URL with Cloudflare Access. The Pages function is disabled if either
setting is absent. Do not put the token in GitHub or in a browser URL.

## Publication gates

The extension reads `Artists`, `Venues`, `Archive 2024`, `Archive 2025`,
`Events_Archive`, and published rows of `Events`. It reads sheet values but
does not modify any sheet or Calendar entry.

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

The existing Apps Script Web app is a public endpoint, so the separate token
is required even for a private preview. The Pages switch and Cloudflare Access
protect the website side. This branch does not install the code, configure
secrets, or deploy either service.
