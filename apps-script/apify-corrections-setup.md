# Activate Corrections in QDP Admin

Add the contents of [ApifyAdminCorrections.gs](ApifyAdminCorrections.gs) as a new file named **ApifyAdminCorrections** in the Index’s existing Apps Script project. The integration uses the existing Calendar and Sheets advanced services, as well as the Apify importer’s Drive folder and image download helper.

## Route the Admin actions

In **Core.gs**, find **qdpAdminHandlePost_**. Add these lines after the token check and the line that defines **action**. Place them before the final Unknown admin action error.

~~~js
  if (action === 'admin.apifycorrection.review') return { ok: 'yes', review: qdpApifyCorrectionReview_(body) };
  if (action === 'admin.apifycorrection.apply') return { ok: 'yes', ...qdpApifyCorrectionApply_(body) };
  if (action === 'admin.apifycorrection.finish') return { ok: 'yes', ...qdpApifyCorrectionFinish_(body) };
~~~

## Protect interrupted corrections during sync

In **pullCalendarToSheetCore_**, add the following near the top of the function, after it defines **singleEvent**.

~~~js
const pendingCorrections = qdpApifyCorrectionPendingIds_();
~~~

In the same function’s Calendar results loop, immediately after **const calId = eventIdForApi_(it.id);**, add this guard. Place it before the cancelled event handling.

~~~js
if (pendingCorrections.has(calId)) {
  if (singleEvent) throw new Error('Finish this event’s pending correction in QDP Admin first.');
  continue;
}
~~~

In **pushSheetToCalendarCore_**, add the following just below its initial **FLAGS.PUSH_ENABLED** check.

~~~js
const pendingCorrections = qdpApifyCorrectionPendingIds_();
~~~

In that function’s row loop, replace the **if (!calId) continue;** immediately before **const srv = server.get(...)** with this guard.

~~~js
if (!calId || pendingCorrections.has(eventIdForApi_(calId))) continue;
~~~

These guards allow the rest of the calendar to sync while a correction’s write is being confirmed. When Admin shows **Finish pending correction**, that action can complete the same approved changes. If a selected field changed after approval, the current values are shown so it can be reconciled before finishing.

## Deploy and check

1. Save the Apps Script changes. Use **Deploy → Manage deployments**, edit the existing web app, select **New version**, and deploy with the same URL.
2. Once the website branch is deployed, open **Admin → Apify Import → Corrections** and upload the scrape workbook. Choose **Review changes** on the event you want to correct.
3. Check individual fields and use **Apply checked changes**. A flyer-only correction saves the image through the Apify Drive folder. Schedule and description changes update the linked Calendar event and the matching Events row. The website picks up the Events row through its regular publication.
