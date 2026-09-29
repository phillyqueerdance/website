# Massive branch archive preview

This branch adds an in-frame archive UI to the existing single-page calendar.
It does **not** create separate HTML pages or include a spreadsheet export.
The directory and profile views have query URLs such as `/?archive=artists`,
`/?archive=artist&id=ARTIST-ID`, `/?archive=venues`, and
`/?archive=events&month=2025-09`. An `&event=EVENT-ID` parameter opens the
existing event popup from a profile or month. The calendar remains at `/`.

The existing `/api/events` endpoint remains the upcoming calendar feed. The
new `/api/archive` function uses the **same** Apps Script deployment URL
(`QDP_APPS_SCRIPT_URL` or the existing fallback). It requests the following
read-only resources. A standalone extension for the supplied Apps Script and
the exact `doGet` insertion are in [`apps-script/`](apps-script/README.md).
They have **not** been installed or deployed to the Web app.

| Site request | Apps Script resource | Expected JSON |
| --- | --- | --- |
| `?resource=artists` | `archiveArtists` | `{ "artists": [profile, ...] }` |
| `?resource=venues` | `archiveVenues` | `{ "venues": [profile, ...] }` |
| `?resource=months` | `archiveMonths` | `{ "months": [{ "month": "2025-09", "count": 42 }, ...] }` |
| `?resource=artist&id=ID` | `archiveArtist&id=ID` | `{ "profile": profile, "events": [event, ...] }` |
| `?resource=venue&id=ID` | `archiveVenue&id=ID` | `{ "profile": profile, "events": [event, ...] }` |
| `?resource=month&month=YYYY-MM` | `archiveMonth&month=YYYY-MM` | `{ "events": [event, ...] }` |

Profiles must use the public fields `id`, `name`, `publicOk: true`, and
optionally `count`, `bio`, `website`, `instagram`; artists may include `music`,
venues may include `address`, `neighborhood`, and `maps`. An artist that has
`Public_OK=Yes` in the live sheet should be emitted with `publicOk: true`.
Nonpublic venues should not be emitted.

Each event must use `eventId`, `title`, `start` as an ISO timestamp with a time
zone, and `public: true`. Other permitted display fields are `end`,
`description`, `venue`, `address`, `venueId`, `artistIds` (an array of IDs),
`flyerUrl`, `status`, `explicitQueer`, `queerArtist`, and `transArtist`. The
read-only Apps Script resources must apply the publication and venue safety
rules before responding and return **only public display fields**. The Pages
function applies a second public flag check, excludes cancelled/deleted rows,
and drops unknown fields. It returns 503 if the resource is missing or shaped
incorrectly, rather than falling back to a bundled data snapshot.

The Apps Script extension must be installed and deployed before these views
can show real archive data. The Pages endpoint also requires
`QDP_ARCHIVE_ENABLED=yes` and `QDP_ARCHIVE_READ_TOKEN` in the protected preview
environment; it is disabled by default. Legacy archive rows require explicit
`Publish_To_Web=Yes`; a missing header does not make the tab public. No Drive
or Apps Script changes, secrets, workbook, generated profile HTML, or
generated JSON were committed to this branch.
When previewing eventually, protect any Cloudflare Pages preview URL with
Cloudflare Access if the archive should remain private; `noindex` is not
access control. The commit to this branch uses Cloudflare's Pages skip-build
prefix to avoid publishing a preview from this push.
