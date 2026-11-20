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

## Google Search Console

The same Analytics page has an independent **Google Search** section. Search
Console clicks, impressions, CTR and average position are not added to QDP's
visitor counters. Reports include daily figures, an equal preceding period,
top 100 search terms, top 100 landing pages, device breakdowns, a result filter,
and a separate CSV export. Totals come from Google's aggregate query rather
than summing privacy-filtered query or page rows. Missing prior data suppresses
comparisons. No individual search is matched to a QDP visitor.

Production setup:

1. Run `migrations/0002_search_console.sql` on the existing analytics database.
2. Add a production **secret**, `QDP_SEARCH_CONSOLE_KEY`, containing 32 random
   bytes encoded as unpadded base64url (43 characters), then redeploy. Keep the
   original value: replacing it makes existing encrypted credentials unreadable.
   Do not copy this secret or the production database binding into previews.
3. In Google Cloud, create/select a project and enable **Google Search Console
   API**. This API is free. Do not enable billing, paid services or BigQuery.
4. Configure Google Auth Platform and create a **Web application** OAuth client
   with this exact authorized redirect URI:
   `https://queerdancephilly.com/admin/search-console-callback`.
   For a new app used solely by its creator, Google's **Personal** mode avoids
   External Testing's seven-day refresh-token expiration. Existing External
   apps cannot switch to Personal; configure an appropriate production app or
   create a new Personal project. Personal mode must use the creator's account.
5. In Analytics > Google Search > Set up the Google connection, enter that
   client's ID and secret. Submit them only in the Access-protected Admin form,
   never in public source, URLs or chat. They are AES-256-GCM encrypted in D1
   with purpose-bound authentication data; the encryption key remains a
   Cloudflare production secret. They are never returned by the private API.
6. Select **Connect Google Search**, choose the Google account with QDP access,
   and consent to the sole scope `webmasters.readonly`. This requires a separate
   Google connection; the ChatGPT Cloudflare plugin connection is insufficient.
   The OAuth flow uses PKCE, a 10-minute encrypted Secure/HttpOnly/SameSite=Lax
   host cookie, and a state bound to the initiating Admin email and connection
   version. Tokens are exchanged server-side and encrypted; no Google tokens
   are sent to browser JavaScript. The callback clears its cookie and redirects
   away from authorization parameters with a no-referrer policy.
7. Only verified QDP properties are accepted. Prefer
   `sc-domain:queerdancephilly.com`, then the HTTPS root URL-prefix property,
   then www/HTTP variants if those are the only authorized QDP properties.
   Access to unrelated Google sites is neither stored nor reported.

Search reports use **Pacific calendar dates**, final Web Search data, and an
explicit three-day processing buffer. Custom dates can cover the available
16-month window; they are separate from the first-party 90-day range controls.
Google may omit anonymized queries and other rows, so tables need not sum to
aggregate totals. Missing daily rows are not invented as zeros or joined by
the chart. Average position is Google's aggregate, not a fixed rank.

Reports refresh on Admin page access when their saved copy is older than six
hours. There is no background job, additional visitor script or paid connector.
Manual refresh is capped at once a minute, with at most 25 report fetches per
UTC day (up to six Search Analytics requests each, plus a token refresh when
needed). The atomic claim is shared by requests. At most 24 report snapshots
are cached, for up to 30 days; stored credentials persist until disconnected.
Quota/authorization failures are shown without a paid fallback or retries.
Disconnect attempts Google token revocation, clears locally stored grants and
report snapshots, and warns if Google could not confirm revocation. The saved
OAuth app configuration remains so it can be reconnected. Replacing an app
requires disconnecting first. Existing visitor collection is independent.

Official references:
- <https://developers.google.com/webmaster-tools/pricing>
- <https://developers.google.com/webmaster-tools/v1/searchanalytics/query>
- <https://developers.google.com/identity/protocols/oauth2/web-server>
- <https://support.google.com/cloud/answer/15549945>

Run `node --test tests/search-console.test.mjs` for encryption, OAuth state and
PKCE, property/scope restrictions, retention/DST dates, authentication, real
SQLite caching and atomic request budgets, token refresh and disconnect tests.

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
