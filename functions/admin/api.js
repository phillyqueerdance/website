const DEFAULT_APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxvCynlGyqJZqP-l6pG_vf2hFAwc-5sSHL9qftqrb5SCclR_8zeKRCHarKEe6XrPjKd/exec";

const ALLOWED_ACTIONS = new Set([
  "admin.bootstrap",
  "admin.status",
  "admin.save",
  "admin.pull",
  "admin.push"
]);

function jsonResponse(
  payload,
  status = 200
) {
  return new Response(
    JSON.stringify(payload),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-store, max-age=0",
        "Content-Security-Policy":
          "default-src 'none'; frame-ancestors 'none'",
        "Referrer-Policy":
          "no-referrer",
        "X-Content-Type-Options":
          "nosniff",
        "X-Frame-Options":
          "DENY"
      }
    }
  );
}

function normalizeTeamDomain(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\/+$/g, "");

  if (!raw) {
    throw new Error(
      "CF_ACCESS_TEAM_DOMAIN is not configured."
    );
  }

  return raw.startsWith("https://")
    ? raw
    : `https://${raw}`;
}

function base64UrlBytes(value) {
  const normalized =
    String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const padded =
    normalized.padEnd(
      Math.ceil(normalized.length / 4) * 4,
      "="
    );

  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );
}

function decodeJwtPart(value) {
  return JSON.parse(
    new TextDecoder().decode(
      base64UrlBytes(value)
    )
  );
}

function commaSeparatedSet(
  value,
  { lowercase = true } = {}
) {
  return new Set(
    String(value || "")
      .split(",")
      .map(item => item.trim())
      .map(item => lowercase ? item.toLowerCase() : item)
      .filter(Boolean)
  );
}

async function accessKeys(
  issuer,
  context
) {
  const certsUrl =
    `${issuer}/cdn-cgi/access/certs`;

  const cacheKey =
    new Request(certsUrl, {
      method: "GET"
    });

  let response =
    await caches.default.match(cacheKey);

  if (!response) {
    response = await fetch(certsUrl, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        "Cloudflare Access signing keys could not be loaded."
      );
    }

    const cacheableResponse =
      new Response(
        response.clone().body,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        }
      );

    cacheableResponse.headers.set(
      "Cache-Control",
      "public, max-age=3600"
    );

    context.waitUntil(
      caches.default.put(
        cacheKey,
        cacheableResponse
      )
    );
  }

  const payload = await response.json();

  if (!Array.isArray(payload.keys)) {
    throw new Error(
      "Cloudflare Access returned invalid signing keys."
    );
  }

  return payload.keys;
}

async function verifyAccess(
  context
) {
  const token =
    context.request.headers.get(
      "Cf-Access-Jwt-Assertion"
    );

  if (!token) {
    throw new Error(
      "Cloudflare Access authentication is required."
    );
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error(
      "Cloudflare Access supplied an invalid token."
    );
  }

  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);

  if (
    header.alg !== "RS256" ||
    !header.kid
  ) {
    throw new Error(
      "Cloudflare Access supplied an unsupported token."
    );
  }

  const issuer = normalizeTeamDomain(
    context.env.CF_ACCESS_TEAM_DOMAIN
  );

  if (
    String(payload.iss || "")
      .replace(/\/+$/g, "") !== issuer
  ) {
    throw new Error(
      "Cloudflare Access token issuer did not match."
    );
  }

  const allowedAudiences =
    commaSeparatedSet(
      context.env.CF_ACCESS_AUD,
      { lowercase: false }
    );

  if (!allowedAudiences.size) {
    throw new Error(
      "CF_ACCESS_AUD is not configured."
    );
  }

  const tokenAudiences =
    Array.isArray(payload.aud)
      ? payload.aud
      : [payload.aud];

  const audienceMatches =
    tokenAudiences.some(value =>
      allowedAudiences.has(
        String(value || "").trim()
      )
    );

  if (!audienceMatches) {
    throw new Error(
      "Cloudflare Access token audience did not match."
    );
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(payload.exp) ||
    payload.exp <= now
  ) {
    throw new Error(
      "Cloudflare Access session has expired."
    );
  }

  if (
    Number.isFinite(payload.nbf) &&
    payload.nbf > now + 30
  ) {
    throw new Error(
      "Cloudflare Access session is not active yet."
    );
  }

  const allowedEmails =
    commaSeparatedSet(
      context.env.QDP_ADMIN_EMAILS
    );

  const email =
    String(payload.email || "")
      .trim()
      .toLowerCase();

  if (
    !allowedEmails.size ||
    !allowedEmails.has(email)
  ) {
    throw new Error(
      "This email address is not authorized for QDP Admin."
    );
  }

  const keys = await accessKeys(
    issuer,
    context
  );

  const signingKey =
    keys.find(key => key.kid === header.kid);

  if (!signingKey) {
    throw new Error(
      "Cloudflare Access signing key was not found."
    );
  }

  const cryptoKey =
    await crypto.subtle.importKey(
      "jwk",
      signingKey,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["verify"]
    );

  const verified =
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      base64UrlBytes(parts[2]),
      new TextEncoder().encode(
        `${parts[0]}.${parts[1]}`
      )
    );

  if (!verified) {
    throw new Error(
      "Cloudflare Access token signature was invalid."
    );
  }

  return { email };
}

function appsScriptUrl(env) {
  return String(
    env.QDP_APPS_SCRIPT_URL ||
    DEFAULT_APPS_SCRIPT_URL
  ).trim();
}

export async function onRequestPost(
  context
) {
  try {
    const requestUrl =
      new URL(context.request.url);

    const origin =
      context.request.headers.get("Origin");

    if (
      origin &&
      origin !== requestUrl.origin
    ) {
      return jsonResponse(
        { error: "Cross-origin requests are not allowed." },
        403
      );
    }

    await verifyAccess(context);

    const sharedSecret =
      String(
        context.env.QDP_ADMIN_SHARED_SECRET ||
        ""
      ).trim();

    if (!sharedSecret) {
      throw new Error(
        "QDP_ADMIN_SHARED_SECRET is not configured."
      );
    }

    const contentLength = Number(
      context.request.headers.get(
        "Content-Length"
      ) || 0
    );

    if (contentLength > 50000) {
      return jsonResponse(
        { error: "The request is too large." },
        413
      );
    }

    const body = await context.request.json();

    if (JSON.stringify(body).length > 50000) {
      return jsonResponse(
        { error: "The request is too large." },
        413
      );
    }

    const action =
      String(body.action || "")
        .trim()
        .toLowerCase();

    if (!ALLOWED_ACTIONS.has(action)) {
      return jsonResponse(
        { error: "Unknown admin action." },
        400
      );
    }

    const upstreamResponse =
      await fetch(
        appsScriptUrl(context.env),
        {
          method: "POST",
          redirect: "follow",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ...body,
            action,
            adminToken: sharedSecret
          })
        }
      );

    if (!upstreamResponse.ok) {
      throw new Error(
        `Apps Script returned ${upstreamResponse.status}.`
      );
    }

    const upstreamPayload =
      await upstreamResponse.json();

    if (upstreamPayload.ok !== "yes") {
      return jsonResponse(
        {
          error:
            upstreamPayload.error ||
            "The admin operation failed."
        },
        400
      );
    }

    return jsonResponse(upstreamPayload);
  } catch (error) {
    console.error(
      "QDP Admin proxy failed:",
      error
    );

    const message =
      error && error.message
        ? error.message
        : "QDP Admin is temporarily unavailable.";

    const authenticationError =
      /Cloudflare Access|authorized/i.test(message);

    return jsonResponse(
      { error: message },
      authenticationError ? 403 : 500
    );
  }
}

export function onRequestGet() {
  return jsonResponse(
    { error: "Use the QDP Admin page." },
    405
  );
}
