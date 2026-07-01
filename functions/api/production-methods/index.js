/**
 * POST /api/production-methods
 *
 * Creates one Production Method (a detail of an existing Order via master-detail)
 * plus zero-or-more Pre-Production Items, in a SINGLE atomic Salesforce call.
 *
 * Uses the Composite API (/composite) with allOrNone:true, so a partial failure
 * rolls the whole thing back -- you never end up with a method that has no items,
 * or orphaned items with no method. The items reference the method's freshly
 * created Id via @{newPM.id}, so no child-relationship-name lookup is needed.
 *
 * Expected JSON body from the browser:
 *   {
 *     "orderId": "801...",            // existing Order Id (required)
 *     "type": "Screen Print",         // Production_Method__c.Type__c picklist value (required)
 *     "items": [                      // 0+ pre-production items
 *       { "type": "Ink",    "status": "Not Started" },
 *       { "type": "Screen", "status": "Not Started" }
 *     ]
 *   }
 *
 * SECURITY: this handler hard-codes exactly which SObjects/fields get written,
 * so the browser can only ever create these two objects with these fields --
 * it can't inject writes to anything else.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

// ---------------------------------------------------------------------------
// ORG-SPECIFIC FIELD API NAMES
// This block is the ONE thing to verify before trusting this file.
// If a name is wrong the Composite API names the exact bad field in its error
// response (e.g. "No such column 'Order__c' on Production_Method__c"), so a
// failure here is LOUD in the JSON response -- not the silent no-op from before.
// ---------------------------------------------------------------------------
const ORDER_FIELD       = "Order__c";              // master-detail: Production_Method__c -> Order   ** VERIFY THIS ONE **
const PM_LOOKUP_FIELD   = "Production_Method__c";  // lookup: Pre_Production_Item__c -> Production_Method__c
const PM_TYPE_FIELD     = "Type__c";               // picklist on Production_Method__c
const ITEM_TYPE_FIELD   = "Type__c";               // picklist on Pre_Production_Item__c
const ITEM_STATUS_FIELD = "Status__c";             // picklist on Pre_Production_Item__c
const DEFAULT_STATUS    = "Not Started";

export async function onRequestPost({ env, request }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const { orderId, type, items } = payload || {};

  // --- validate before touching Salesforce ---
  if (!orderId || typeof orderId !== "string") return jsonError("missing_orderId", 400);
  if (!type || typeof type !== "string")       return jsonError("missing_type", 400);
  const itemList = Array.isArray(items) ? items : [];

  const v = apiVersion(env);

  // Method first; each item references the created method's Id via @{newPM.id}.
  const compositeRequest = [
    {
      method: "POST",
      url: `/services/data/${v}/sobjects/Production_Method__c`,
      referenceId: "newPM",
      body: {
        [ORDER_FIELD]: orderId,
        [PM_TYPE_FIELD]: type,
      },
    },
    ...itemList.map((item, i) => ({
      method: "POST",
      url: `/services/data/${v}/sobjects/Pre_Production_Item__c`,
      referenceId: `item${i}`,
      body: {
        [PM_LOOKUP_FIELD]: "@{newPM.id}",
        [ITEM_TYPE_FIELD]: item.type,
        [ITEM_STATUS_FIELD]: item.status || DEFAULT_STATUS,
      },
    })),
  ];

  try {
    const resp = await sfFetch(env, `/services/data/${v}/composite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allOrNone: true, compositeRequest }),
    });
    const data = await resp.json();

    // NOTE: /composite returns HTTP 200 even when a sub-request failed.
    // Inspect each sub-result's httpStatusCode to detect the real outcome.
    const subResults = Array.isArray(data.compositeResponse) ? data.compositeResponse : [];
    const failed = subResults.find(
      (r) => r.httpStatusCode < 200 || r.httpStatusCode >= 300
    );

    if (!resp.ok || failed) {
      console.error("Production method create failed", resp.status, JSON.stringify(data));
      // Surface Salesforce's own error so the UI can show WHY (bad picklist
      // value, missing field, or 403 INSUFFICIENT_ACCESS = run-as user lacks Create).
      return Response.json(
        { error: "create_failed", detail: failed ? failed.body : data },
        { status: 502 }
      );
    }

    const pmResult = subResults.find((r) => r.referenceId === "newPM");
    return Response.json(
      { ok: true, productionMethodId: pmResult?.body?.id ?? null, raw: data.compositeResponse },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
