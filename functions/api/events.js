const GOOGLE_EVENTS_URL =
  "https://script.google.com/macros/s/AKfycbxvCynlGyqJZqP-l6pG_vf2hFAwc-5sSHL9qftqrb5SCclR_8zeKRCHarKEe6XrPjKd/exec?resource=events";

const EDGE_CACHE_SECONDS = 300;

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
    cacheStatus = "MISS"
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
            ? `public, max-age=${EDGE_CACHE_SECONDS}`
            : "no-store",

        "X-QDP-Cache":
          cacheStatus,

        "X-Content-Type-Options":
          "nosniff"
      }
    }
  );
}

export async function onRequestGet(
  context
) {
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
