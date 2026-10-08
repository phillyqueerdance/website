# Massive branch archive preview

This branch adds an in-frame archive UI to the existing single-page calendar.
Cloudflare renders individual event URLs into complete HTML responses; no
spreadsheet export is bundled with the site.
The directory and profile views have query URLs such as `/?archive=artists`,
`/?archive=artist&id=ARTIST-ID`, `/?archive=venues`, and
`/?archive=events&month=2025-09`. An `&event=EVENT-ID` parameter opens the
existing event popup from a profile or month. The calendar remains at `/`.

The existing `/api/events` endpoint remains the upcoming calendar feed. The
new `/api/archive` function uses a prepared copy of public archive data when
the Preview environment has a populated `QDP_ARCHIVE_KV` binding. Until then,
it uses the **same** Apps Script deployment URL (`QDP_APPS_SCRIPT_URL` or the
existing fallback). Its fallback requests the following read-only resources.
The publisher and setup are in [`apps-script/`](apps-script/README.md).
The existing public Apps Script Web app now serves these resources. The
prepared-data publisher is an addition to that existing project.

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

The `massive` Pages preview is deployed and the existing Apps Script feed works.
Legacy archive rows require explicit `Publish_To_Web=Yes`; a missing header
does not make the tab public. The Web app and the branch preview are publicly
reachable, and `noindex` is not access control. No Drive data, workbook,
generated profile HTML, or generated JSON is committed to this branch.

## Faster prepared-data path

The publisher in the existing Apps Script project reads each archive source
and active events once per refresh. It prepares three directories, four
artist groups, two venue groups, and four month groups, then writes a small
manifest last. The reader selects one group for a profile or month, checks
the published revision, and applies the same output allowlist as its live
feed. It bypasses the old five-minute edge cache for prepared responses.
Updates run within about 15 minutes after an edit when the refresh trigger
is installed, or immediately when `qdpArchivePublish` is run manually.
Unchanged data causes no KV writes. The branch uses the live feed during
setup or a partial update. Only the preview environment should receive the
binding; `main` remains untouched.


## Permanent individual event pages

`/?event=EVENT-ID` and contextual archive event links resolve through
`/api/event`, independently of the filtered current calendar. The server
renders one selected event and its canonical URL, description, image, and
eligible Event JSON-LD. The browser preserves that URL through refreshes,
restores the original Back destination, and provides real event anchor links.
`/sitemap.xml` lists unique canonical public event URLs. Unavailable events
return 404 after the new index is installed; incomplete snapshots return 503.

The publisher now writes 27 grouped records plus the manifest, including eight
event shards with public related-profile links. A cold indexed event lookup
uses the manifest and one shard; a warm normalized lookup uses the edge cache.
Past month views include ended rows still on the active Events sheet. The
compatibility path can resolve existing archived events while the Apps Script
update is pending. Installation and production checks are in the publisher
[README](apps-script/README.md#permanent-event-links-and-google-event-markup).
