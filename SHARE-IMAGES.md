# Event link-preview images

The Share button continues to share the permanent event URL. Its Open Graph
and Twitter image is `/api/event-share-image?event=…&v=…`. The image contains
the popup frame, full flyer, local date, flags, and applicable background.
It excludes the title, description, and Back navigation.

Image rendering runs in the **Prepare event share images** GitHub workflow,
on relevant main-branch changes and every 30 minutes. It reads only the
existing public `/api/events` and monthly `/api/archive` endpoints. It has
no Google account or Admin access and needs no user-provided secrets.

Native resvg prepares at most 250 missing images per run, prioritizing the
current calendar and then working backward through the archive. Unchanged
images are reused. Failed public flyer downloads retry on the next run.
PNG files are stored as assets on monthly `qdp-share-images-YYYY-MM`
prereleases, keeping binary artwork and public feed copies out of Git history.
Only the GitHub job uses `contents: write`; the website reads public files.

The live image endpoint performs the usual event publication check, then
serves the prepared PNG. It never renders images, writes KV, or accesses a
Google account. A missing image or temporary storage failure redirects to
the original public flyer with a short cache lifetime. Withdrawing an event
blocks the endpoint within the existing 60-second publication cache window.

The filename is a SHA-256 digest of the event ID and visible image inputs.
A changed date, flyer URL, flag, party background, or layout version creates
a new asset automatically. Change `popup-2` in `event-metadata.js` when
changing artwork or layout to regenerate existing images. The job removes
obsolete assets from the months it visits; do not place unrelated assets
with the generated `event-<digest>.png` filename pattern on these releases.

GitHub's scheduled jobs may be delayed. Events published between runs keep
their original flyer preview until preparation completes. Social apps may
also retain an older preview for links they have already cached.
