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

/**
 * Runs one SOQL query and follows Salesforce's pagination (done/
 * nextRecordsUrl) until the whole result set has been fetched, returning
 * every matching record in one array -- never just the first page.
 *
 * Salesforce's /query endpoint only returns up to one "batch" per call (2000
 * records by default, sometimes fewer depending on org settings). A larger
 * result comes back with `done: false` and a `nextRecordsUrl` you're
 * expected to re-fetch, repeatedly, until `done: true`. Every endpoint in
 * this app used to read `data.records` straight off the FIRST response only
 * -- fine while result sets stayed under the batch size, but a silent,
 * no-error truncation waiting to happen the moment one didn't (see
 * production-orders/index.js's Order__r.Status = 'Complete' clause, which
 * has no date bound and only grows over the life of the shop). Added
 * 2026-07-29 so every list endpoint gets this for free instead of each
 * needing its own copy of the follow-the-link loop.
 *
 * `nextRecordsUrl` comes back from Salesforce already in the
 * "/services/data/vNN.0/query/<locator>" shape sfFetch expects, so it's
 * passed straight through as the next call's `path`.
 *
 * Returns { ok, status, records, data } where `data` is the LAST response
 * received (matching what a raw sfFetch+resp.json() caller used to get, so
 * error logging/shape stays the same) and `records` is the full
 * concatenated array. If any page after the first fails, stops there and
 * returns what was already collected rather than losing it -- callers that
 * care can inspect `ok`/`status` from that failed page.
 */
export async function runQuery(env, soql) {
  const path = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;
  let resp = await sfFetch(env, path);
  let data = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { ok: false, status: resp.status, records: [], data };
  }

  let records = (data && data.records) || [];
  let nextUrl = data && data.nextRecordsUrl;
  let done = !data || data.done !== false;

  while (!done && nextUrl) {
    resp = await sfFetch(env, nextUrl);
    const pageData = await resp.json().catch(() => null);
    if (!resp.ok) {
      // Keep whatever was already collected; report the failure via
      // ok/status so callers can still decide to serve the partial list
      // (better than losing page 1 just because page 2 hiccuped) or fail
      // loudly, as they prefer.
      return { ok: false, status: resp.status, records, data: pageData };
    }
    records = records.concat((pageData && pageData.records) || []);
    nextUrl = pageData && pageData.nextRecordsUrl;
    done = !pageData || pageData.done !== false;
    data = pageData;
  }

  return { ok: true, status: resp.status, records, data };
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

/**
 * Optimistic-concurrency check: re-fetches ONE record's LastModifiedDate and
 * compares it to the timestamp the caller says it had when it loaded the
 * record for editing. Used by PATCH handlers for records that get opened
 * into a form and edited over some real span of time (a production method's
 * edit panel, a production run's row) -- two people on different tablets
 * editing the same record used to be pure last-write-wins with zero warning.
 *
 * Returns:
 *   { conflict: false }                                   -- safe to write
 *   { conflict: true, currentLastModifiedDate }            -- someone else
 *                                                              saved more
 *                                                              recently
 *
 * `ifUnmodifiedSince` is optional and falsy skips the check entirely (return
 * { conflict:false }) -- callers that don't pass it get the old, unguarded
 * behavior, which is deliberate: this is opt-in per PATCH call, not a global
 * requirement, since not every field on every object needs this (see the
 * callers in production-methods/[id].js and production-runs/[id].js for
 * which fields actually opt in).
 *
 * A failed re-fetch (network hiccup, record deleted, etc.) does NOT block
 * the save -- it just means the conflict check is skipped for that attempt,
 * same as if the caller never asked for one. This is a UI nicety, not a
 * data-integrity guarantee (Cloudflare Access / Salesforce's own row
 * security is that); erring toward "let the save through" over "block a
 * legitimate save because a status check failed" matches that.
 */
export async function checkNotModifiedSince(env, sobject, id, ifUnmodifiedSince) {
  if (!ifUnmodifiedSince) return { conflict: false };
  try {
    const path = `/services/data/${apiVersion(env)}/sobjects/${sobject}/${encodeURIComponent(id)}?fields=LastModifiedDate`;
    const resp = await sfFetch(env, path);
    if (!resp.ok) return { conflict: false };
    const data = await resp.json();
    const current = data && data.LastModifiedDate;
    if (!current) return { conflict: false };
    const currentTime = Date.parse(current);
    const loadedTime = Date.parse(ifUnmodifiedSince);
    if (!Number.isFinite(currentTime) || !Number.isFinite(loadedTime)) return { conflict: false };
    if (currentTime > loadedTime) return { conflict: true, currentLastModifiedDate: current };
    return { conflict: false };
  } catch (err) {
    console.error("checkNotModifiedSince failed", sobject, id, err);
    return { conflict: false };
  }
}
