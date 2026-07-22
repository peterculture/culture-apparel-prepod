/**
 * PATCH /api/production-methods/:id
 *
 * Updates ONE Production_Method__c: its Status__c (the Production floor
 * board, index.html) and/or its own copy of the 7 pre-production checklist
 * booleans (the pre-production worker board, pre-production.html).
 *
 * These booleans used to live ONLY on Order -- one shared set for the whole
 * order, no matter how many methods it had. An order with a screen print
 * method AND a heat press method had exactly one "Screens Completed"
 * checkbox for both, and two screen-print methods on the same order (front
 * + back) couldn't be tracked independently at all. Production_Method__c
 * now carries its own copy of each field (created 2026-07-21), so every
 * method gets its own checklist.
 *
 * Body (send any subset of these):
 *   {
 *     "Status__c": "In Production",       // validated against ALLOWED_STATUSES
 *     "orderId":   "801...",               // NOT written to Salesforce -- only used,
 *                                           //   when Status__c is also present, to roll
 *                                           //   the parent Order's Order_Substatus__c up
 *                                           //   to whichever sibling method is least
 *                                           //   advanced. See ../_pm-rollup.js.
 *     "Films_Printed__c": true,
 *     "Screens_Completed__c": true,
 *     "Mix_Inks__c": false,
 *     "Digitize_File__c": true,
 *     "Thread_Color_Materials__c": true,
 *     "Transfers_Received__c": false,
 *     "Transfers_Ready__c": false,
 *     "Print_Setup_Timer__c": 1320,        // elapsed seconds, this method's own
 *     "Production_Timer__c": 2460          // clock -- see ../_ppi-checklist.js note
 *   }                                       // in index.html for the order-total sum
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { rollupOrderSubstatus } from "../_pm-rollup.js";
import { cascadeChecklistToItems } from "../_ppi-checklist.js";

const PM_OBJECT = "Production_Method__c";

// Exact Status__c picklist values, confirmed from Setup 2026-07-02. Keep in
// sync with ALLOWED_STATUSES in production-methods/index.js.
const ALLOWED_STATUSES = new Set([
  "Pre-Production", "Ready for Print", "In Production",
  "Post-Production", "Completed", "Cancelled", "On Hold",
]);

// Per-method pre-production checklist booleans (mirrors the Order-level
// fields of the same name -- see orders/[id].js CHECKLIST_FIELDS). All 7
// exist on every Production_Method__c regardless of its own Type__c; the
// UI only shows/toggles the 2-3 relevant to that method's own method type.
const CHECKLIST_FIELDS = new Set([
  "Films_Printed__c",
  "Screens_Completed__c",
  "Mix_Inks__c",
  "Digitize_File__c",
  "Thread_Color_Materials__c",
  "Transfers_Received__c",
  "Transfers_Ready__c",
]);

// Per-method timers (mirrors Order's Print_Setup_Timer__c/Production_Timer__c
// -- same field names, same Number(18,0) type, now also on Production_Method__c
// so sibling methods on one order time independently. Stored as whole elapsed
// seconds; the client sums siblings for the order-level combined readout.
const TIMER_FIELDS = new Set([
  "Print_Setup_Timer__c",
  "Production_Timer__c",
]);

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export async function onRequestPatch({ params, request, env }) {
  try {
    const id = params && params.id;
    if (!SF_ID.test(id)) return jsonError("invalid_id", 400);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    if (!body || typeof body !== "object") return jsonError("invalid_body", 400);

    const orderId = body.orderId;
    if (orderId != null && !SF_ID.test(orderId)) {
      return jsonError("invalid_orderId", 400);
    }

    const payload = {};

    if ("Status__c" in body) {
      const status = body.Status__c;
      if (!status || typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
        return jsonError("bad_status", 400);
      }
      payload.Status__c = status;
    }

    for (const field of CHECKLIST_FIELDS) {
      if (field in body) payload[field] = !!body[field];
    }

    for (const field of TIMER_FIELDS) {
      if (field in body) {
        const n = Number(body[field]);
        if (!Number.isFinite(n) || n < 0) return jsonError("bad_timer_value", 400);
        payload[field] = Math.floor(n);
      }
    }

    if (Object.keys(payload).length === 0) return jsonError("no_valid_fields", 400);

    const path = `/services/data/${apiVersion(env)}/sobjects/${PM_OBJECT}/${id}`;
    const resp = await sfFetch(env, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.status !== 204) {
      const detail = await resp.text();
      console.error("Production method update failed", resp.status, detail);
      return jsonError("update_failed", resp.status);
    }

    // Cascade any checklist box that was just checked TRUE down onto its
    // matching Pre_Production_Item__c records, scoped to THIS method (see
    // ../_ppi-checklist.js). Best-effort: awaited so the items are in sync by
    // the time the client re-fetches, but a cascade failure doesn't undo or
    // fail the checklist write that already succeeded.
    const checkedNow = Array.from(CHECKLIST_FIELDS).filter((f) => payload[f] === true);
    if (checkedNow.length) {
      await cascadeChecklistToItems(env, id, checkedNow).catch((e) =>
        console.error("checklist cascade failed", e),
      );
    }

    // Best-effort: keep Order_Substatus__c an honest summary of its methods.
    // Only relevant when Status__c just changed; never fails this response.
    let rolledUpSubstatus = null;
    if (orderId && "Status__c" in payload) {
      rolledUpSubstatus = await rollupOrderSubstatus(env, orderId).catch((e) => {
        console.error("order substatus rollup failed", e);
        return null;
      });
    }

    return Response.json(
      { ok: true, id, updated: Object.keys(payload), rolledUpSubstatus },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
