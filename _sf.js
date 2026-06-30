/**
 * Shared Salesforce helper for Cloudflare Pages Functions.
 *
 * Files prefixed with "_" are NOT exposed as routes by Pages, but they can
 * still be imported by the route handlers. This module:
 *   1. Gets an access token from Salesforce using the Client Credentials flow
 *      (server-to-server, no user login, no browser CORS involved).
 *   2. Caches that token in the isolate's module scope until it nears expiry.
 *   3. Exposes a small fetch wrapper that retries once on a 401 (expired token).
 *
 * Required environment variables (set in the Cloudflare Pages dashboard):
 *   SF_LOGIN_URL     e.g. https://YOURDOMAIN--dev2.sandbox.my.salesforce.com
 *   SF_CLIENT_ID     Consumer Key from the External Client App / Connected App
 *   SF_CLIENT_SECRET Consumer Secret (mark as encrypted/secret in the dashboard)
 *   SF_API_VERSION   optional, defaults to v60.0
 */

// Lives in module scope -> survives across requests handled by the same isolate.
let cachedToken = null; // { access_token, instance_url, expiresAt }

export async function getSalesforceToken(env, { force = false } = {}) {
  const now = Date.now();
  if (!force && cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken;
  }

  const resp = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SF_CLIENT_ID,
      client_secret: env.SF_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    // Log details server-side only; never return secrets/raw errors to the browser.
    const detail = await resp.text();
    console.error("Salesforce token request failed", resp.status, detail);
    throw new Error(`sf_auth_failed_${resp.status}`);
  }

  const data = await resp.json();
  // Salesforce client_credentials tokens follow the org session timeout
  // (commonly 2h). Cache for 90 min to stay comfortably inside that window.
  cachedToken = {
    access_token: data.access_token,
    instance_url: data.instance_url, // use this, not SF_LOGIN_URL, for API calls
    expiresAt: now + 90 * 60 * 1000,
  };
  return cachedToken;
}

/**
 * Authenticated fetch against the Salesforce REST API.
 * `path` is everything after instance_url, e.g.
 *   "/services/data/v60.0/query/?q=..."
 * Retries once with a fresh token if the first attempt returns 401.
 */
export async function sfFetch(env, path, init = {}) {
  let token = await getSalesforceToken(env);

  const doFetch = (t) =>
    fetch(`${t.instance_url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        ...(init.headers || {}),
      },
    });

  let resp = await doFetch(token);
  if (resp.status === 401) {
    token = await getSalesforceToken(env, { force: true });
    resp = await doFetch(token);
  }
  return resp;
}

export function apiVersion(env) {
  return env.SF_API_VERSION || "v60.0";
}

// Helper for consistent JSON error responses to the browser.
export function jsonError(message, status = 502) {
  return Response.json({ error: message }, { status });
}
