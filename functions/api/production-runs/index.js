/**
 * POST /api/production-runs
 *
 * Creates ONE Production_Run__c, from the "Create Production Run" modal that
 * opens right after a Production Method is created in pre-production.html
 * (Management view). Mirrors the native Salesforce "New Production Run"
 * quick action off a Production Method's Production Runs related list --
 * same object, same fields -- so runs created here show up identically in
 * Setup/Lightning.
 *
 * Expected JSON body from the browser:
 *   {
 *     "printMethodId": "a3V...",           // Production_Method__c Id (required)
 *     "pressId":       "001...",           // Account Id, Type = 'Press' (required)
 *     "scheduledStart": "2026-07-25T14:00:00.000Z", // ISO datetime (required)
 *     "scheduledEnd":   "2026-07-25T17:00:00.000Z", // ISO datetime (required)
 *     "quantity": 48                        // garments to print this run (required)
 *   }
 *
 * ORG-SPECIFIC API NAMES (confirmed live in Setup 2026-07-22 -- Object
 * Manager -> Production Run -> Fields & Relationships):
 *   PrintMethod__c        Lookup(Production Method)
 *   Press__c              Lookup(Account)
 *   Scheduled_Start__c    Date/Time
 *   Scheduled_End__c      Date/Time
 *   Quantity_Planned_c__c Number(18,0) -- labeled "Total Quantity" in Setup.
 *                          NOTE the org's own naming quirk: the field's
 *                          Field Name is literally "Quantity_Planned_c",
 *                          so Salesforce's automatic "__c" suffix lands on
 *                          top of that -- the real API name has "_c__c",
 *                          not "__c". Do not "fix" this to Quantity_Planned__c;
 *                          that field doesn't exist and the write will 400.
 *
 * Only Production Method is actually required on Production_Run__c itself
 * (confirmed via the native New Production Run form), but this endpoint
 * requires all five -- the app's UI treats Press/Scheduled Start & End/
 * Quantity as mandatory for a run to be usable on the shop floor.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const PR_OBJECT = "Production_Run__c";
const PR_PRINTMETHOD_FIELD = "PrintMethod__c";
const PR_PRESS_FIELD = "Press__c";
const PR_SCHED_START_FIELD = "Scheduled_Start__c";
const PR_SCHED_END_FIELD = "Scheduled_End__c";
const PR_QTY_FIELD = "Quantity_Planned_c__c";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

function parseIso(v) {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export async function onRequestPost({ env, request }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const { printMethodId, pressId, scheduledStart, scheduledEnd, quantity } = payload || {};

  if (!printMethodId || !SF_ID.test(printMethodId)) return jsonError("missing_printMethodId", 400);
  if (!pressId || !SF_ID.test(pressId)) return jsonError("missing_pressId", 400);

  const start = parseIso(scheduledStart);
  if (!start) return jsonError("bad_scheduledStart", 400);
  const end = parseIso(scheduledEnd);
  if (!end) return jsonError("bad_scheduledEnd", 400);
  if (end.getTime() < start.getTime()) return jsonError("scheduledEnd_before_scheduledStart", 400);

  const qtyNum = Number(quantity);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0 || qtyNum > 999999 || Math.floor(qtyNum) !== qtyNum) {
    return jsonError("bad_quantity", 400);
  }

  const body = {
    [PR_PRINTMETHOD_FIELD]: printMethodId,
    [PR_PRESS_FIELD]: pressId,
    [PR_SCHED_START_FIELD]: start.toISOString(),
    [PR_SCHED_END_FIELD]: end.toISOString(),
    [PR_QTY_FIELD]: qtyNum,
  };

  try {
    const path = `/services/data/${apiVersion(env)}/sobjects/${PR_OBJECT}`;
    const resp = await sfFetch(env, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data || data.success === false) {
      console.error("Production run create failed", resp.status, JSON.stringify(data));
      return Response.json(
        { error: "create_failed", detail: data },
        { status: 502 },
      );
    }

    return Response.json(
      { ok: true, id: data.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
