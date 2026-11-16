# Save corrections to Apify Import

1. Add [ApifyAdminCorrections.gs](ApifyAdminCorrections.gs) to the Index’s Apps Script project as **ApifyAdminCorrections**. If you tried the earlier draft, replace the contents of that file and remove its three correction routes and the pending-correction guards from Pull and Push in **Core.gs**.
2. In **Core.gs**, find **qdpAdminHandlePost_**. Add the following line after the token check and the line that defines **action**, before the Unknown admin action error.

~~~js
if (action === 'admin.apifycorrection.stage') return { ok: 'yes', ...qdpApifyCorrectionStage_(body) };
~~~

3. Save, then use **Deploy → Manage deployments** to deploy a new version of the existing Apps Script web app. Keep the same deployment URL. The handler uses the Google Sheets advanced service and the date/time cell formatter from the current **ApifyAdminImport.gs**.
4. Once the updated website is deployed, open **Admin → Apify Import → Corrections**. Upload the workbook, check the fields you want, and choose **Save correction to Apify Import**.

The correction is appended to **Apify Import** with its EventID, **Review** set to **Correction**, and just the approved changes. The approved-field list is in **Review_notes** and **ImportSourceSnapshot**. A selected blank description is recorded in the snapshot, so it can be distinguished from an unchecked description.

The existing new-event importer accepts rows marked **Include**. Use the **Correction** rows as your record when you decide which corrections to make separately.
