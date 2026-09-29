# Install the archive feed in the existing QDP Apps Script project

This folder contains a read-only extension based on the supplied v6.3 script.
The branch does not contain the full Apps Script, spreadsheet ID, sheet data,
or script properties. The diagnostic run confirms the helpers are installed,
but does not establish which version of the Web app is deployed.

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

The existing Apps Script Web app is public. Once its new version is deployed,
these approved fields are retrievable directly from that Web app as well as
the `massive` Pages preview. `noindex` on the preview is not access control.
This branch does not change the Apps Script deployment itself.
