export const DEFAULT_APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxvCynlGyqJZqP-l6pG_vf2hFAwc-5sSHL9qftqrb5SCclR_8zeKRCHarKEe6XrPjKd/exec";

const GOOGLE_EVENTS_URL = `${DEFAULT_APPS_SCRIPT_URL}?resource=events`;

const EDGE_CACHE_SECONDS = 300;
const PREPARED_CACHE_SECONDS = 30;
const PREPARED_MAX_AGE_MS = 6 * 60 * 1000;
const PREPARED_KEY = "qdp-live:v1:feed";

function phillyDateKey(date) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(date);
}

function isCurrentOrFutureEvent(event, today) {
  const endValue =
    event.end || event.start;

  const endDate =
    new Date(endValue);

  if (
    Number.isNaN(endDate.getTime())
  ) {
    return false;
  }

  return phillyDateKey(endDate) >= today;
}

function createJsonResponse(
  payload,
  {
    status = 200,
    cacheStatus = "MISS",
    maxAge = EDGE_CACHE_SECONDS
  } = {}
) {
  return new Response(
    JSON.stringify(payload),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          status === 200
            ? `public, max-age=${maxAge}`
            : "no-store",

        "X-QDP-Cache":
          cacheStatus,

        "X-Content-Type-Options":
          "nosniff"
      }
    }
  );
}

export async function readPreparedEvents(context) {
  const kv = context.env?.QDP_PUBLIC_FEED_KV || context.env?.QDP_ARCHIVE_KV;
  if (!kv) return null;
  const record = await kv.get(PREPARED_KEY, "json");
  const published = Date.parse(record?.publishedAt);
  const age = Date.now() - published;
  if (record?.schema !== 1 || !Array.isArray(record.payload?.events) ||
      !Number.isFinite(age) || age < 0 || age > PREPARED_MAX_AGE_MS) return null;
  const today = phillyDateKey(new Date());
  return {
    generatedAt: record.payload.generatedAt,
    events: record.payload.events.filter(event =>
      event && event.eventId && event.title && isCurrentOrFutureEvent(event, today))
  };
}

export async function onRequestGet(
  context
) {
  try {
    const prepared = await readPreparedEvents(context);
    if (prepared) {
      return createJsonResponse(prepared, {
        cacheStatus: "PREPARED",
        maxAge: PREPARED_CACHE_SECONDS
      });
    }
  } catch (error) {
    console.error("Prepared QDP events unavailable; using live feed:", error);
  }

  const cache =
    caches.default;

  const cacheUrl =
    new URL(context.request.url);

  cacheUrl.search = "";

  const cacheKey =
    new Request(
      cacheUrl.toString(),
      { method: "GET" }
    );

  const cachedResponse =
    await cache.match(cacheKey);

  if (cachedResponse) {
    const headers =
      new Headers(
        cachedResponse.headers
      );

    headers.set(
      "X-QDP-Cache",
      "HIT"
    );

    return new Response(
      cachedResponse.body,
      {
        status:
          cachedResponse.status,

        statusText:
          cachedResponse.statusText,

        headers
      }
    );
  }

  try {
    const upstreamResponse =
      await fetch(
        GOOGLE_EVENTS_URL,
        {
          redirect: "follow",
          headers: {
            Accept: "application/json"
          }
        }
      );

    if (!upstreamResponse.ok) {
      throw new Error(
        `Google returned ${upstreamResponse.status}.`
      );
    }

    const payload =
      await upstreamResponse.json();

    if (payload.error) {
      throw new Error(
        payload.error
      );
    }

    if (
      !Array.isArray(payload.events)
    ) {
      throw new Error(
        "Google returned an invalid event feed."
      );
    }

    const today =
      phillyDateKey(new Date());

    const filteredPayload = {
      ...payload,

      events:
        payload.events.filter(
          event =>
            isCurrentOrFutureEvent(
              event,
              today
            )
        )
    };

    const response =
      createJsonResponse(
        filteredPayload
      );

    context.waitUntil(
      cache.put(
        cacheKey,
        response.clone()
      )
    );

    return response;
  } catch (error) {
    console.error(
      "QDP event proxy failed:",
      error
    );

    return createJsonResponse(
      {
        error:
          "The event feed is temporarily unavailable."
      },
      {
        status: 502,
        cacheStatus: "ERROR"
      }
    );
  }
}
