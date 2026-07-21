/**
 * PATCH /api/production-methods/:id
 *
 * Updates ONE Production_Method__c's Status__c. This is what lets the
 * Production floor board (index.html) move a single method (e.g. the Heat
 * Press job on an order) through Ready for Print -> In Production ->
 * Post-Production -> Completed independently of that same order's other
 * methods, instead of the whole order sharing one shared stage.
 *
 * Body:
 *   {
 *     "Status__c": "In Production",  // required, validated against ALLOWED_STATUSES
 *     "orderId":   "801..."          // optional -- NOT written to Salesforce itself,
 *                                     //   just used afterward to look up this method's
 *                                     //   siblings so the parent Order's
 *                                     //   Order_Substatus__c can be rolled up to match
 *                                     //   whichever method is least advanced. See
 *                                     //   ../_pm-rollup.js. Omit it and only this
 *                                     //   method's own status gets written.
 *   }
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { rollupOrderSubstatus } from "../_pm-rollup.js";

const PM_OBJECT = "Production_Method__c";

// Exact Status__c picklist values, confirmed from Setup 2026-07-02. Keep in
// sync with ALLOWED_STATUSES in production-methods/index.js.
const ALLOWED_STATUSES = new Set([
  "Pre-Production", "Ready for Print", "In Production",
  "Post-Production", "Completed", "Cancelled", "On Hold",
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

    const status = body && body.Status__c;
    const orderId = body && body.orderId;
    if (!status || typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
      return jsonError("bad_status", 400);
    }
    if (orderId != null && !SF_ID.test(orderId)) {
      return jsonError("invalid_orderId", 400);
    }

    const path = `/services/data/${apiVersion(env)}/sobjects/${PM_OBJECT}/${id}`;
    const resp = await sfFetch(env, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Status__c: status }),
    });

    if (resp.status !== 204) {
      const detail = await resp.text();
      console.error("Production method status update failed", resp.status, detail);
      return jsonError("update_failed", resp.status);
    }

    // Best-effort: keep Order_Substatus__c an honest summary of its methods.
    // Never fails this response -- the method write already succeeded.
    let rolledUpSubstatus = null;
    if (orderId) {
      rolledUpSubstatus = await rollupOrderSubstatus(env, orderId).catch((e) => {
        console.error("order substatus rollup failed", e);
        return null;
      });
    }

    return Response.json(
      { ok: true, id, Status__c: status, rolledUpSubstatus },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
