/**
 * PATCH /api/orders/:id
 *
 * Updates a single Order's pre-production fields. Only fields on the allow-list
 * below can be written -- this prevents the public proxy from being used to
 * modify arbitrary Salesforce fields. Salesforce returns 204 No Content on a
 * successful update.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

// NOTE (2026-07-22): this endpoint used to cascade any checklist box checked
// TRUE here down onto matching Pre_Production_Item__c records. That cascade
// was built against the OLD shared, order-level checklist -- since the
// 2026-07-21 per-method migration, checklist toggles are written per
// Production_Method__c via production-methods/[id].js, which now owns the
// (correctly method-scoped) cascade itself; see ../_ppi-checklist.js. The
// legacy order-level checklist fields below are still writable through this
// endpoint for any other caller, but no cascade runs off them anymore -- a
// stale cascade scoped to Production_Method__c off an Order Id would just
// silently match nothing, which is worse than no cascade at all.

const ALLOWED_FIELDS = new Set([
  "Receiving_Status__c",
  // Screen Print
  "Films_Printed__c",
  "Screens_Completed__c",
  "Mix_Inks__c",
  // Embroidery
  "Digitize_File__c",
  "Thread_Color_Materials__c",
  // Heat Press
  "Transfers_Received__c",
  "Transfers_Ready__c",
  // Order-level production stage ("Production Status" path in Salesforce UI)
  "Order_Substatus__c",
  // Production Dashboard (In Production / Post-Production / shipping)
  "Print_Setup_Timer__c",
  "Production_Timer__c",
  "Misprint__c",
  "Misprint_Details__c",
  // How many garments were affected -- lets a manager see misprint scale at a
  // glance instead of reading free text. Reuses the org's existing
  // TotalQtyMisprints__c field (Number 5,0) rather than adding a new one.
  "TotalQtyMisprints__c",
  "Packaging_Count__c",
  "Production_Notes__c",
  // Editable from the Production drawer: print specs and special/rush notes.
  "Specifications_for_Printing__c",
  "Special_Notes__c",
  "Shipping_Delivery__c",
  "Shipping_Label_Printed__c",
  // Audit trail: free-text name of whoever made this change, captured client-side
  // at login (there's no per-worker Salesforce user -- both dashboards share one
  // Worker PIN and one Manager PIN). NOTE: this field must exist on Order in
  // Salesforce (Text(80), e.g. Last_Updated_By__c) before this ships, or every
  // PATCH that includes it will fail with INVALID_FIELD.
  "Last_Updated_By__c",
]);

// Order_Substatus__c picklist values, confirmed against Setup 2026-07-14.
// Dependent on standard Status (controlling field); Status stays 'Pre-Production'
// for shop orders throughout this whole pipeline, so it isn't written here.
// NOTE: the picklist entry displayed as "In Production" has an actual stored
// API value of "Production" -- its label was changed in Salesforce (Peter
// Larson, 7/12/2026) without updating the underlying value. Every other
// stage's label matches its value. The value here must be "Production";
// sending the literal label "In Production" fails with
// INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. Confirmed via ui-api/object-info,
// 2026-07-14. The client (index.html / pre-production.html) translates the
// display label to this value before sending.
const ALLOWED_SUBSTATUSES = new Set([
  "Pre-Production", "Ready for Print", "Production", "Post-Production", "Completed",
]);

// Shipping_Delivery__c picklist values, confirmed 2026-07-14. "Delivery" added
// 2026-07-22 -- must exist on the Shipping_Delivery__c picklist in Salesforce
// (Setup -> Object Manager -> Order -> Fields) before this ships, or a PATCH
// sending it fails with INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST.
const ALLOWED_DELIVERY_METHODS = new Set([
  "Shipping", "Local Dropoff", "Pickup", "Order Fulfillment", "Split Ship", "Delivery",
]);

// Salesforce IDs are 15 or 18 chars, alphanumeric. Validate before using in a URL.
const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export async function onRequestPatch({ params, request, env }) {
  try {
    const id = params.id;
    if (!SF_ID.test(id)) {
      return jsonError("invalid_id", 400);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }

    const payload = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (ALLOWED_FIELDS.has(k)) payload[k] = v;
    }
    if (Object.keys(payload).length === 0) {
      return jsonError("no_allowed_fields", 400);
    }
    if ("Last_Updated_By__c" in payload) {
      const name = payload.Last_Updated_By__c;
      payload.Last_Updated_By__c = name ? String(name).slice(0, 80) : null;
    }
    if ("TotalQtyMisprints__c" in payload) {
      const raw = payload.TotalQtyMisprints__c;
      if (raw === null || raw === "") {
        payload.TotalQtyMisprints__c = null;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 99999) return jsonError("bad_misprint_quantity", 400);
        payload.TotalQtyMisprints__c = Math.floor(n);
      }
    }
    if (
      "Order_Substatus__c" in payload &&
      !ALLOWED_SUBSTATUSES.has(payload.Order_Substatus__c)
    ) {
      return jsonError("bad_substatus", 400);
    }
    if (
      "Shipping_Delivery__c" in payload &&
      payload.Shipping_Delivery__c &&
      !ALLOWED_DELIVERY_METHODS.has(payload.Shipping_Delivery__c)
    ) {
      return jsonError("bad_delivery_method", 400);
    }

    const path = `/services/data/${apiVersion(env)}/sobjects/Order/${id}`;
    const resp = await sfFetch(env, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.status === 204) {
      return new Response(null, { status: 204 });
    }

    const detail = await resp.text();
    console.error("Salesforce update failed", resp.status, detail);
    return jsonError("update_failed", resp.status);
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
