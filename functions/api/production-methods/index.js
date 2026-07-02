/**
 * POST /api/production-methods
 *
 * Creates a Production Method (+ its Pre-Production Items) for one order,
 * atomically. The Method's ProductionPlan__c parent is supplied one of two ways:
 *
 *   A) EXISTING PLAN  — body includes { planId }.
 *      Just the Method + Items are created, attached to that plan.
 *
 *   B) CREATE FRESH   — body omits planId.
 *      The chain Order → ProductionRequirements__c → ProductionPlan__c is
 *      created first, then the Method + Items hang off the new plan:
 *
 *        Order (exists)
 *          └─ ProductionRequirements__c   (Order__c master-detail)
 *               └─ ProductionPlan__c      (ProductionRequirement__c master-detail)
 *                    └─ Production_Method__c
 *                         └─ Pre_Production_Item__c × N
 *
 * Everything runs in ONE Composite call with allOrNone:true, so a partial
 * failure rolls the whole thing back. Levels reference each other via @{ref.id}.
 *
 * Expected JSON body from the browser:
 *   {
 *     "orderId":  "801...",          // existing Order Id (required)
 *     "vendorId": "001...",          // Account Id for Vendor__c (required)
 *     "status":   "Pre-Production",  // Production_Method__c.Status__c (required, manager-set)
 *     "type":     "Screen Print",    // Production_Method__c.Type__c (required)
 *     "planId":   "a0X...",          // OPTIONAL existing ProductionPlan__c Id.
 *                                    //   present -> path A (attach); absent -> path B (create chain)
 *     "items": [ { "type": "Screen" }, { "type": "Ink" } ]   // 0+ items
 *   }
 *
 * SECURITY: hard-codes exactly which SObjects/fields get written; the browser
 * can only ever create these objects with these fields, and picklist values are
 * checked against allow-lists below.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

// ---------------------------------------------------------------------------
// ORG-SPECIFIC API NAMES  (confirmed against the sandbox 2026-07-02)
// A wrong name makes the Composite API name the exact bad field/object in its
// error, which this handler forwards as `detail` — loud, never a silent no-op.
// ---------------------------------------------------------------------------
const REQ_OBJECT        = "ProductionRequirements__c";
const REQ_ORDER_FIELD   = "Order__c";                 // master-detail: Requirement -> Order

const PLAN_OBJECT       = "ProductionPlan__c";
const PLAN_REQ_FIELD    = "ProductionRequirement__c"; // master-detail: Plan -> Requirement

const PM_OBJECT         = "Production_Method__c";
const PM_PLAN_FIELD     = "ProductionPlan__c";         // master-detail: Method -> Plan (required)
const PM_ORDER_FIELD    = "Order__c";                  // also required on Method
const PM_VENDOR_FIELD   = "Vendor__c";                 // lookup -> Account (required)
const PM_STATUS_FIELD   = "Status__c";                 // picklist (required, manager-set)
const PM_TYPE_FIELD     = "Type__c";                   // picklist (required)

const ITEM_OBJECT       = "Pre_Production_Item__c";
const ITEM_PM_FIELD     = "Production_Method__c";      // lookup -> Method
const ITEM_TYPE_FIELD   = "Type__c";                   // picklist: Screen|Ink|Thread|Digitization|Transfer
const ITEM_STATUS_FIELD = "Status__c";                 // picklist
const ITEM_STATUS_DEFAULT = "Not Started";

// Allow-lists, enforced server-side so the browser can't write arbitrary values.
const ALLOWED_METHOD_TYPES = new Set(["Screen Print", "Embroidery", "Heat Press", "Promotional Items"]);
const ALLOWED_ITEM_TYPES   = new Set(["Screen", "Ink", "Thread", "Digitization", "Transfer"]);
// Exact Status__c picklist values, confirmed from Setup 2026-07-02.
const ALLOWED_STATUSES     = new Set([
  "Pre-Production", "Ready for Print", "In Production",
  "Post-Production", "Completed", "Cancelled", "On Hold",
]);

export async function onRequestPost({ env, request }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const { orderId, vendorId, status, type, planId, items } = payload || {};

  // --- validate before touching Salesforce ---
  if (!orderId || typeof orderId !== "string")   return jsonError("missing_orderId", 400);
  if (!vendorId || typeof vendorId !== "string") return jsonError("missing_vendorId", 400);
  if (!status || typeof status !== "string")     return jsonError("missing_status", 400);
  if (!ALLOWED_STATUSES.has(status))             return jsonError("bad_status", 400);
  if (!type || typeof type !== "string")         return jsonError("missing_type", 400);
  if (!ALLOWED_METHOD_TYPES.has(type))           return jsonError("bad_method_type", 400);

  const hasExistingPlan = typeof planId === "string" && planId.length > 0;

  const itemList = Array.isArray(items) ? items : [];
  for (const it of itemList) {
    if (!it || !ALLOWED_ITEM_TYPES.has(it.type)) {
      return Response.json({ error: "bad_item_type", detail: it && it.type }, { status: 400 });
    }
  }

  const v = apiVersion(env);
  const base = `/services/data/${v}/sobjects`;

  // The Method's plan parent: either the existing planId, or @{plan.id} from the
  // freshly-created chain.
  const planRef = hasExistingPlan ? planId : "@{plan.id}";

  const compositeRequest = [];

  // Path B: create Requirement + Plan first.
  if (!hasExistingPlan) {
    compositeRequest.push(
      {
        method: "POST",
        url: `${base}/${REQ_OBJECT}`,
        referenceId: "req",
        body: { [REQ_ORDER_FIELD]: orderId },
      },
      {
        method: "POST",
        url: `${base}/${PLAN_OBJECT}`,
        referenceId: "plan",
        body: { [PLAN_REQ_FIELD]: "@{req.id}" },
      }
    );
  }

  // Method (both paths).
  compositeRequest.push({
    method: "POST",
    url: `${base}/${PM_OBJECT}`,
    referenceId: "pm",
    body: {
      [PM_PLAN_FIELD]:   planRef,
      [PM_ORDER_FIELD]:  orderId,
      [PM_VENDOR_FIELD]: vendorId,
      [PM_STATUS_FIELD]: status,
      [PM_TYPE_FIELD]:   type,
    },
  });

  // Items (both paths).
  itemList.forEach((item, i) => {
    compositeRequest.push({
      method: "POST",
      url: `${base}/${ITEM_OBJECT}`,
      referenceId: `item${i}`,
      body: {
        [ITEM_PM_FIELD]:     "@{pm.id}",
        [ITEM_TYPE_FIELD]:   item.type,
        [ITEM_STATUS_FIELD]: item.status || ITEM_STATUS_DEFAULT,
      },
    });
  });

  try {
    const resp = await sfFetch(env, `/services/data/${v}/composite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allOrNone: true, compositeRequest }),
    });
    const data = await resp.json();

    // /composite returns HTTP 200 even when a sub-request failed; inspect each.
    const subResults = Array.isArray(data.compositeResponse) ? data.compositeResponse : [];

    // Pull the code out of a sub-result's body (body can be an array of errors).
    const codeOf = (r) => {
      const b = r && r.body;
      if (Array.isArray(b) && b[0]) return b[0].errorCode || "";
      if (b && b.errorCode) return b.errorCode;
      return "";
    };
    const isErr = (r) => r.httpStatusCode < 200 || r.httpStatusCode >= 300;

    // The REAL failure is the errored sub-result that ISN'T just a rolled-back
    // sibling. PROCESSING_HALTED means "some OTHER record failed", so skip those
    // and report the record that actually caused the rollback.
    const errored = subResults.filter(isErr);
    const realFailure =
      errored.find((r) => codeOf(r) !== "PROCESSING_HALTED") || errored[0] || null;

    if (!resp.ok || realFailure) {
      console.error("Method create failed", resp.status, JSON.stringify(data));
      return Response.json(
        {
          error: "create_failed",
          // Which record failed (referenceId: req | plan | pm | itemN) + SF's message.
          failedRef: realFailure ? realFailure.referenceId : null,
          detail: realFailure ? realFailure.body : data,
          // Full array so every sub-result is visible in the Network response.
          all: subResults.map((r) => ({ referenceId: r.referenceId, httpStatusCode: r.httpStatusCode, body: r.body })),
        },
        { status: 502 }
      );
    }

    const byRef = (ref) => subResults.find((r) => r.referenceId === ref)?.body?.id ?? null;
    return Response.json(
      {
        ok: true,
        requirementId: hasExistingPlan ? null : byRef("req"),
        planId: hasExistingPlan ? planId : byRef("plan"),
        productionMethodId: byRef("pm"),
        raw: data.compositeResponse,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
