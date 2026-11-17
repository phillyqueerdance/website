# Apply checked corrections from the Index

1. In **Admin → Apify Import → Corrections**, check the fields you want and click **Save correction to Apify Import**. The approved fields and the original EventID are saved on that tab.
2. In the Index, select those **Correction** rows and choose **Apify import → Apply Selected Corrections**. It matches each EventID and writes the checked values to the existing **Events** row. Flyer changes use the current Apify flyer folder. For a time or description change, the command also reads the linked Calendar event to record the comparison for Push.
3. Run your regular **Push**. It sends the approved times and descriptions from **Events** to the linked Calendar event. Check **Import_result** on the intake rows for the result.

Pull preserves the approved fields while they await Push. Push checks for edits to those fields in Events or Calendar since Apply. If a row says **Push needs review**, compare the values before choosing to apply it again. An approved blank description can clear the Calendar description. Flyer-only corrections finish when the Events row is saved.

## Add the Apps Script files and menu item

Add [ApifyAdminCorrections.gs](ApifyAdminCorrections.gs) and [ApifySheetCorrections.gs](ApifySheetCorrections.gs) to the Index’s Apps Script project as separate script files. Use the current [ApifyAdminImport.gs](ApifyAdminImport.gs) for the Admin date/time formatter. The correction commands use the project’s existing Calendar and Sheets advanced services and the same flyer folder as the new-event importer.

If you tried the earlier direct-apply draft, replace **ApifyAdminCorrections** and remove its three correction routes and its pending-correction guards from **Core.gs** before adding the lines below.

In **Core.gs**, inside **qdpAdminHandlePost_**, add this line after the token check and the line that defines **action**, if you have not already added it.

~~~js
if (action === 'admin.apifycorrection.stage') return { ok: 'yes', ...qdpApifyCorrectionStage_(body) };
~~~

In the script that defines **qdpShowApifyMenu**, add the following item to the existing **Apify import** menu chain, immediately before **.addToUi()**.

~~~js
.addItem('Apply Selected Corrections', 'qdpApplySelectedApifyCorrections')
~~~

## Wire the regular sync into the corrections

In **pullCalendarToSheetCore_**, add this below **const columnCount = H.length;**.

~~~js
const apifyPending = targetSheetName === CONFIG.SHEET_EVENTS
  ? qdpPendingApifyCorrectionFields_(eSh.getParent())
  : new Map();
~~~

In the same function’s **setLocal(curr, ci, val)** helper, add this after **if (!ci) return false;**.

~~~js
const held = apifyPending.get(qdpApifyCorrectionId_(curr[eIdx['EventID']]));
if (held && (
  (held.has('description') && ci === colDesc) ||
  (held.has('start') && (ci === colStartDate || ci === colStartTime)) ||
  (held.has('end') && (ci === colEndDate || ci === colEndTime))
)) return false;
~~~

In **pushSheetToCalendarCore_**, find the line that reads **const rows = eSh.getRange(...).getValues();**. Add this immediately below it.

~~~js
const apifyCorrections = qdpPushApifyCorrections_(eSh.getParent(), { sheet: eSh, headers: H, rows });
~~~

In the same function, update these two lines to count Calendar patches from Corrections in the Push result.

~~~js
let writes = apifyCorrections.patched;
let changedAny = writes > 0;
~~~

In the Push row loop, replace **if (!calId) continue;** with the following.

~~~js
if (!calId || apifyCorrections.eventIds.has(qdpApifyCorrectionId_(r[eIdx['EventID']])) ||
    apifyCorrections.calendarIds.has(eventIdForApi_(calId))) continue;
~~~

In that function’s final return object, update **acknowledged** and add **correctionFailures**.

~~~js
acknowledged: syncedAtUpdates.length + apifyCorrections.acknowledged,
correctionFailures: apifyCorrections.failures.length,
~~~

Save the project. Use **Deploy → Manage deployments → Edit → New version → Deploy** on the existing web app and reload the Index to load its updated menu. The website part comes from this pull request.

