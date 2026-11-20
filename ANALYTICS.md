# QDP Admin analytics

The Analytics page is `/admin/analytics`. The main Admin page includes a small
seven-day summary. Both read the same first-party daily counters, protected by
the existing Cloudflare Access JWT verification. No Apps Script changes are
needed, and analytics does not write to the Index or Calendar.

## Free-only deployment

Do not enable collection until the account is verified to use **Workers Free**.
An account's free web/domain plan is separate from its Workers subscription.
Do not upgrade plans or enable a paid fallback. Workers and D1 quotas are shared
with other applications in the account.

1. In Cloudflare's D1 dashboard, create a database named `qdp-analytics` on the
   existing Free account. Reuse that database when resuming setup.
2. Run `migrations/0001_analytics.sql` in its console. The migration is
   idempotent; it creates four analytics-only tables and deletes no records.
3. In the existing QDP Pages project's production bindings, add the D1 database
   as `QDP_ANALYTICS`.
4. After verifying Workers Free, set the production environment variable
   `QDP_ANALYTICS_FREE_PLAN` to `confirmed`. This is an explicit configuration
   gate, not an automatic verification of the Cloudflare subscription.
5. Deploy the updated code to the existing Pages project. Binding/environment
   changes need a new deployment. Do not create a replacement site.
6. Open `/admin/analytics` through the existing Admin sign-in. Until configured,
   the page reports setup incomplete and the public collector remains off.
7. Admin excludes its browser by default. To verify collection, explicitly
   uncheck the browser exclusion in Analytics, open the public site, view an
   event, and copy its link where available. Allow about 12 seconds for a batch.
   Refresh Analytics, confirm the counters, then restore browser exclusion.

No Cloudflare API token is needed. Counts are collected directly into the bound
database. Existing Cloudflare Web Analytics continues separately; its historical
totals are not imported or presented as these counters.

## What is counted

| Counter | Definition |
| --- | --- |
| Recorded visits | Activity in a tab after 30 minutes of inactivity. A timestamp in sessionStorage prevents a reload from creating another visit. No visitor identifier is created. |
| Section views | Successful visible Calendar, event, profile, directory, map, About, or Melt views. Refreshing the same visible view does not add a count. |
| Event/profile opens | Successful visible detail/profile views, labeled with the previous QDP section or direct entry. |
| Listing impressions | Event cards at least 50% visible for 0.8 seconds, excluding hidden/inert content; once per EventID and section per document. |
| Link copies | A completed clipboard operation. |
| Share dialogs | A call to the browser's native share interface; delivery is not inferred. |
| Calendar/directions/external clicks | Activation of the relevant link. They do not establish saves, ticket sales or attendance. |
| Discovery activity | Map centers, relationship opens, filter changes, directory searches, and gallery opens. Initial map centers are included. Search text and filter choices are not stored. |

These counts are not unique people, Cloudflare's visit totals, or a census of all
activity. Privacy controls, blockers, request failures and collection caps can
reduce recorded counts. Opens and impressions have different definitions, so the
dashboard does not divide them into a misleading conversion percentage.

Only metric, Philadelphia date, public event/entity ID and title, coarse source,
device category and count are retained. No IPs, persistent visitor IDs, cookies,
full URLs, browser versions or search text are stored. Referrals use hostnames
and a small allowlist of campaign source names. No identity flags are collected.

## Quotas, gaps and storage

- The collector batches up to 24 counter updates in one request, has an 18 KB
  request-body ceiling, and limits the client queue and per-document activity.
- Each UTC day has an additional 20,000 conservative write-unit budget. This
  leaves headroom below D1 Free's allowance; it is not a measurement of the
  account's total Cloudflare usage. The database's budget claim and counter
  writes are one transaction, so simultaneous requests cannot exceed this cap.
- A rejected budget marks known partial dates. Manual pause intervals are
  retained after resuming, and pre-tracking dates are unavailable rather than
  zero. Comparisons are suppressed when the history is insufficient or has
  known gaps. Unknown blocked/dropped requests cannot be reconstructed.
- Free-provider quota errors stop collection. The client does not retry failed
  batches or retain an unlimited offline backlog. Tracking does not block
  navigation, sharing or event editing.
- Static assets are separate from dynamic Worker request allowances. Because
  the free request quota is account-wide, heavy collection can still affect
  other dynamic endpoints. This implementation reduces requests but does not
  promise that an account-wide quota can never be exhausted.
- Daily aggregates persist until storage capacity is reached; they do not expire
  after three months. No unbounded raw click log is stored. The free database's
  storage is finite. If it fills, stop collection and export/archive old totals;
  do not upgrade automatically. The CSV button exports the displayed period's
  totals and the top 100 events/profiles, not the entire database.

The private API caches computed summaries for five minutes after authentication.
Refresh explicitly bypasses this cache. Custom ranges cover up to 90 days per
request, with an equally long previous period. Rankings are limited to the top
100 events/profiles by opens/views before client-side filtering or sorting.

## Verification

Run `node --test tests/analytics*.test.mjs` for actual SQLite transaction, quota,
date, authentication, and client tracking checks. Run the existing public-site
tests after changes to event, archive, map, or photo hooks.
