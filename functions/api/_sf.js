/**
 * Shared Salesforce helper for Cloudflare Pages Functions.
 *
 * Files prefixed with "_" are NOT exposed as routes by Pages, but they can
 * still be imported by the route handlers. This module:
 *   1. Tracks which named Salesforce org ("environment") is currently active,
 *      shared across every request/user via the INVENTORY KV namespace --
 *      see admin/sf-env.js, the endpoint that reads/changes it.
 *   2. Gets an access token from that org using the Client Credentials flow
 *      (server-to-server, no user login, no browser CORS involved).
 *   3. Caches that token PER ENVIRONMENT in the isolate's module scope until
 *      it nears expiry, so switching environments doesn't need to force a
 *      cache-bust -- each org's cache entry lives independently, and a
 *      still-fresh token is reused if you switch back to it.
 *   4. Exposes a small fetch wrapper that retries once on a 401 (expired token).
 *
 * ENVIRONMENTS
 *   SF_ENVIRONMENTS below is the fixed list of selectable orgs. Each one
 *   needs its own credential triplet in the Cloudflare Pages dashboard
 *   (Settings -> Variables and Secrets), named with that environment's key
 *   UPPERCASED:
 *     SF_ENV_DEV2_LOGIN_URL        e.g. https://YOURDOMAIN--dev2.sandbox.my.salesforce.com
 *     SF_ENV_DEV2_CLIENT_ID        Consumer Key from that org's Connected/External Client App
 *     SF_ENV_DEV2_CLIENT_SECRET    Consumer Secret (mark encrypted/secret)
 *   ...and the same three, suffixed _STAGING / _PRODUCTION, for the other
 *   entries in SF_ENVIRONMENTS. An environment with any of its three vars
 *   missing is reported as unconfigured (see isEnvConfigured) and can't be
 *   switched to -- "production" ships here as a placeholder with no
 *   credentials yet, on purpose, until that org exists.
 *
 *   SF_API_VERSION   optional, defaults to v60.0 -- shared across all
 *                    environments (not org-specific in practice).
 *
 *   SF_ZK_ORDER_FIELD_ID_<ENV>   Id of the zkmulti__MCShipment__c.Order__c
 *                    custom lookup field in that org (see
 *                    orders/[id]/zk-wizard-url.js's header comment for how
 *                    to find it -- it's a real per-org metadata Id, not
 *                    something that migrates with a change set). Falls back
 *                    to the unsuffixed SF_ZK_ORDER_FIELD_ID if the suffixed
 *                    var isn't set, since dev2 and Staging happen to share
 *                    the same value today (confirmed 2026-07-27 -- both
 *                    sandboxes trace back to the same lineage).
 */

export const SF_ENVIRONMENTS = [
  { key: "dev2", label: "Dev2" },
  { key: "staging", label: "Staging" },
  { key: "production", label: "Production" },
];
const ENV_KEYS = new Set(SF_ENVIRONMENTS.map((e) => e.key));
const DEFAULT_ENV = "dev2"; // status quo if KV has nothing set yet, or is unreachable
const ACTIVE_ENV_KV_KEY = "sf_env:active";

function credsFor(env, envKey) {
  const up = envKey.toUpperCase();
  return {
    loginUrl: env[`SF_ENV_${up}_LOGIN_URL`],
    clientId: env[`SF_ENV_${up}_CLIENT_ID`],
    clientSecret: env[`SF_ENV_${up}_CLIENT_SECRET`],
  };
}

/** True if every credential this environment needs is actually set. */
export function isEnvConfigured(env, envKey) {
  const c = credsFor(env, envKey);
  return !!(c.loginUrl && c.clientId && c.clientSecret);
}

/**
 * Which environment is live right now, shared across all requests/users.
 * Falls back to DEFAULT_ENV if KV isn't bound, has nothing stored yet, or
 * somehow holds a value outside SF_ENVIRONMENTS (e.g. a since-removed key).
 */
export async function getActiveSfEnv(env) {
  if (!env.INVENTORY) return DEFAULT_ENV;
  try {
    const stored = await env.INVENTORY.get(ACTIVE_ENV_KV_KEY);
    return stored && ENV_KEYS.has(stored) ? stored : DEFAULT_ENV;
  } catch (err) {
    console.error("getActiveSfEnv: KV read failed, defaulting to", DEFAULT_ENV, err);
    return DEFAULT_ENV;
  }
}

/** Used only by admin/sf-env.js's POST handler after it validates the PIN. */
export async function setActiveSfEnv(env, envKey) {
  if (!env.INVENTORY) throw new Error("kv_not_bound");
  if (!ENV_KEYS.has(envKey)) throw new Error("unknown_env");
  await env.INVENTORY.put(ACTIVE_ENV_KV_KEY, envKey);
}

// Keyed by environment key, not a single value -- see header comment.
const cachedTokens = new Map(); // envKey -> { access_token, instance_url, expiresAt }

export async function getSalesforceToken(env, { force = false } = {}) {
  const envKey = await getActiveSfEnv(env);
  const now = Date.now();
  const cached = cachedTokens.get(envKey);
  if (!force && cached && cached.expiresAt > now + 60_000) {
    return cached;
  }

  const creds = credsFor(env, envKey);
  if (!creds.loginUrl || !creds.clientId || !creds.clientSecret) {
    console.error(`getSalesforceToken: environment "${envKey}" is missing credentials`);
    throw new Error(`sf_env_not_configured_${envKey}`);
  }

  const resp = await fetch(`${creds.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });

  if (!resp.ok) {
    // Log details server-side only; never return secrets/raw errors to the browser.
    const detail = await resp.text();
    console.error("Salesforce token request failed", envKey, resp.status, detail);
    throw new Error(`sf_auth_failed_${resp.status}`);
  }

  const data = await resp.json();
  // Salesforce client_credentials tokens follow the org session timeout
  // (commonly 2h). Cache for 90 min to stay comfortably inside that window.
  const token = {
    access_token: data.access_token,
    instance_url: data.instance_url, // use this, not the login URL, for API calls
    expiresAt: now + 90 * 60 * 1000,
  };
  cachedTokens.set(envKey, token);
  return token;
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

/** Org-specific Zenkraft field Id for the currently active environment. */
export async function getZkOrderFieldId(env) {
  const envKey = await getActiveSfEnv(env);
  return env[`SF_ZK_ORDER_FIELD_ID_${envKey.toUpperCase()}`] || env.SF_ZK_ORDER_FIELD_ID || null;
}

// Helper for consistent JSON error responses to the browser.
export function jsonError(message, status = 502) {
  return Response.json({ error: message }, { status });
}
