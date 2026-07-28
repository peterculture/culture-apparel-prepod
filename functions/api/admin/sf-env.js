/**
 * GET  /api/admin/sf-env
 *   Returns which Salesforce environment is currently active (shared across
 *   every user of the app -- see _sf.js's getActiveSfEnv) and the full list
 *   of selectable environments, each flagged with whether its credentials
 *   are actually configured yet (e.g. "production" ships as a placeholder
 *   with no credentials until that org exists).
 *   { active: "dev2", environments: [{ key, label, configured, active }] }
 *
 * POST /api/admin/sf-env
 *   Switches the active environment. Body: { env: "staging", pin: "1234" }.
 *   Requires SF_ENV_SWITCH_PIN to be set and matched -- this flips which org
 *   every user's next request talks to, so it's gated the same way the
 *   station tablets are (see _station.js's header comment: this is
 *   app-level defense in depth, not a replacement for Cloudflare Access
 *   sitting in front of /api/*).
 *   Rejects switching to an environment that isn't fully configured (missing
 *   any of its three SF_ENV_<KEY>_* credentials) rather than leaving the app
 *   pointed at an org it can't authenticate against.
 */
import { SF_ENVIRONMENTS, getActiveSfEnv, setActiveSfEnv, isEnvConfigured, jsonError } from "../_sf.js";
import { safeEqual } from "../_station.js";

export async function onRequestGet({ env }) {
  try {
    const active = await getActiveSfEnv(env);
    const environments = SF_ENVIRONMENTS.map((e) => ({
      key: e.key,
      label: e.label,
      configured: isEnvConfigured(env, e.key),
      active: e.key === active,
    }));
    return Response.json({ active, environments }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    if (!body || typeof body !== "object") return jsonError("invalid_body", 400);

    const envKey = String(body.env || "");
    if (!SF_ENVIRONMENTS.some((e) => e.key === envKey)) return jsonError("unknown_env", 400);

    const configuredPin = env.SF_ENV_SWITCH_PIN;
    if (!configuredPin) {
      console.error("sf-env POST: SF_ENV_SWITCH_PIN is not set -- refusing to switch");
      return jsonError("pin_not_configured", 500);
    }
    const suppliedPin = String(body.pin == null ? "" : body.pin);
    if (!safeEqual(suppliedPin, configuredPin)) return jsonError("wrong_pin", 401);

    if (!isEnvConfigured(env, envKey)) return jsonError("env_not_configured", 409);

    await setActiveSfEnv(env, envKey);
    return Response.json({ ok: true, active: envKey }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
