/**
 * POST /api/orders/:id/reprint
 *
 * Ports Salesforce's "Production Error" quick action (Order → Flow
 * "SCREEN Order Reprint Process", API name SCREEN_Order_Reprint_Process) into
 * this proxy. That Flow is a Screen Flow, so it can't be invoked headlessly
 * over REST -- this endpoint reimplements its four writes as one Composite
 * call instead, the same pattern production-methods/index.js already uses
 * for its Requirement -> Plan -> Method -> Items chain.
 *
 * REVERSE-ENGINEERED FROM (2026-07-27, dev2 sandbox, Flow Builder, version 19
 * -- the Flow itself has had no Active Version since 2026-06-12, so this was
 * read off a Draft version, not confirmed against a live run):
 *
 *   1. Create a new child Order, copying most fields from the original and
 *      flagging it as a misprint/reprint order, linked back via
 *      Original_Production_Order__c. Restarts at Status = 'Pre-Production'
 *      so it re-enters the shop floor from scratch.
 *   2. Create one new OrderItem per submitted line (only lines where the
 *      manager entered a misprint and/or damaged quantity), cloned from the
 *      matching original OrderItem but reassigned to the new Order and with
 *      Quantity = misprintQty + damagedQty.
 *   3. Patch the ORIGINAL Order's Misprint_Details__c / TotalQtyMisprints__c
 *      -- both already writable via orders/[id].js's ALLOWED_FIELDS, just
 *      nothing in this app set them before now.
 *
 * NOT ported (deliberate v1 scope cut, see PRODUCTION-ERROR-REPRINT-ANALYSIS.md):
 *   - Re-linking ContentDocumentLink (mockup files) onto the new order.
 *   - The Flow's "ProductionErrorNotification" email to the Opportunity
 *     Owner + Order Owner.
 *
 * WHY NO Production_Method__c / Pre_Production_Item__c HERE: the Flow never
 * created one either -- it only creates the Order + OrderItems. That means
 * the new reprint order needs no new board logic: it has Status =
 * 'Pre-Production' and no method yet, so it surfaces in the existing
 * Pre-Production Management inbox (/api/inbox) exactly like a brand-new
 * order, and a manager routes it through the Create Production Method flow
 * you already have.
 *
 * Expected JSON body from the browser:
 *   {
 *     "items": [
 *       { "orderItemId": "802...", "misprintQty": 5, "damagedQty": 0 },
 *       ...
 *     ],
 *     "misprintDetails": "free text reason",
 *     "by": "Worker Name"   // optional, stamped as Last_Updated_By__c
 *   }
 * Only items where misprintQty + damagedQty > 0 are actioned; the rest are
 * ignored server-side even if included.
 */
import { sfFetch, apiVersion, jsonError } from "../../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

// Order fields copied straight from the original onto the new child Order.
// Confirmed against Setup -> Object Manager -> Order -> Fields, 2026-07-27
// (labels shown in the Flow's "Create Child Order" step, API names looked up
// directly -- see PRODUCTION-ERROR-REPRINT-ANALYSIS.md for the full table).
const ORIGINAL_ORDER_FIELDS = [
  "Id",
  "AccountId",
  "BillToContactId",
  "ShipToContactId",
  "Customer_Facing_Delivery_Date__c", // "Client Deadline"
  "Customer_Order_Name__c",
  "Decoration_Method__c",
  "OpportunityId",
  "Pricebook2Id",
  "Printer__c",
  "RecordTypeId",
  "Shipping_Delivery__c", // "Delivery Method"
  "Special_Notes__c",
  "Specifications_for_Printing__c",
  "Type", // "Order Type", standard field
  "TotalQtyMisprints__c", // read so the patch below can add to it, not overwrite it
];
const COPIED_ORDER_FIELDS = ORIGINAL_ORDER_FIELDS.filter(
  (f) => f !== "Id" && f !== "TotalQtyMisprints__c",
);

// OrderItem fields cloned onto each new reprint line. The Flow's "Get Order
// Products" step pulled full OrderItem records (whatever a native "New
// Production Run"-style clone needs, i.e. everything Salesforce requires to
// insert a line -- typically PricebookEntryId + UnitPrice alongside
// Product2Id), then only overwrote OrderId/Quantity. Mirrored here rather
// than guessing a minimal field set, since an org-required field left off
// would fail the whole composite call.
const ORIGINAL_ITEM_FIELDS = [
  "Id",
  "Product2Id",
  "PricebookEntryId",
  "UnitPrice",
  "Description",
  "Color__c",
  "Size__c",
];

function isPosInt(n) {
  return Number.isFinite(n) && n >= 0 && Math.floor(n) === n;
}

export async function onRequestPost({ params, request, env }) {
  try {
    const orderId = params && params.id;
    if (!SF_ID.test(orderId)) return jsonError("invalid_id", 400);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    if (!body || typeof body !== "object") return jsonError("invalid_body", 400);

    const misprintDetails = body.misprintDetails == null ? "" : String(body.misprintDetails).slice(0, 255);
    const by = (body.by == null ? "" : String(body.by)).trim().slice(0, 80);

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const lines = [];
    for (const it of rawItems) {
      if (!it || !SF_ID.test(it.orderItemId)) return jsonError("bad_orderItemId", 400);
      const misprintQty = Number(it.misprintQty) || 0;
      const damagedQty = Number(it.damagedQty) || 0;
      if (!isPosInt(misprintQty) || !isPosInt(damagedQty)) return jsonError("bad_quantity", 400);
      const qty = misprintQty + damagedQty;
      if (qty > 0) lines.push({ orderItemId: it.orderItemId, misprintQty, damagedQty, qty });
    }
    if (!lines.length) return jsonError("no_lines_with_quantity", 400);

    const v = apiVersion(env);

    // 1. Fetch the original Order's fields to copy.
    const orderSoql = `SELECT ${ORIGINAL_ORDER_FIELDS.join(", ")} FROM Order WHERE Id = '${orderId}'`;
    const orderResp = await sfFetch(
      env,
      `/services/data/${v}/query/?q=${encodeURIComponent(orderSoql)}`,
    );
    const orderData = await orderResp.json();
    if (!orderResp.ok) {
      console.error("reprint: original order fetch failed", orderResp.status, JSON.stringify(orderData));
      return jsonError("order_fetch_failed", orderResp.status);
    }
    const originalOrder = orderData.records && orderData.records[0];
    if (!originalOrder) return jsonError("order_not_found", 404);

    // 2. Fetch the submitted OrderItem rows, scoped to this Order so a
    // client can't smuggle in a line item from a different order.
    const itemIds = lines.map((l) => l.orderItemId);
    const quotedIds = itemIds.map((oid) => `'${oid}'`).join(",");
    const itemSoql =
      `SELECT ${ORIGINAL_ITEM_FIELDS.join(", ")} FROM OrderItem ` +
      `WHERE Id IN (${quotedIds}) AND OrderId = '${orderId}'`;
    const itemResp = await sfFetch(
      env,
      `/services/data/${v}/query/?q=${encodeURIComponent(itemSoql)}`,
    );
    const itemData = await itemResp.json();
    if (!itemResp.ok) {
      console.error("reprint: order item fetch failed", itemResp.status, JSON.stringify(itemData));
      return jsonError("items_fetch_failed", itemResp.status);
    }
    const foundItems = itemData.records || [];
    if (foundItems.length !== lines.length) {
      // One or more submitted orderItemIds didn't resolve to a real line on
      // this order -- reject rather than silently create a partial set.
      return jsonError("item_order_mismatch", 400);
    }
    const itemById = new Map(foundItems.map((r) => [r.Id, r]));

    // 3. Build the Composite request: create child Order, create each
    // reprint OrderItem off it, patch the original Order's misprint fields.
    // allOrNone so a bad line can't leave a half-created reprint behind.
    const base = `/services/data/${v}/sobjects`;
    const compositeRequest = [];

    const childOrderBody = {};
    for (const field of COPIED_ORDER_FIELDS) {
      if (originalOrder[field] !== undefined) childOrderBody[field] = originalOrder[field];
    }
    Object.assign(childOrderBody, {
      EffectiveDate: new Date().toISOString().slice(0, 10), // "Order Start Date", today
      IsReductionOrder: false,
      Misprint__c: true,
      Misprint_Details__c: misprintDetails || null,
      Order_Substatus__c: "Pre-Production", // "Production Status"
      Status: "Pre-Production",
      Original_Production_Order__c: orderId,
    });
    if (by) childOrderBody.Last_Updated_By__c = by;

    compositeRequest.push({
      method: "POST",
      url: `${base}/Order`,
      referenceId: "childOrder",
      body: childOrderBody,
    });

    lines.forEach((line, i) => {
      const src = itemById.get(line.orderItemId);
      const itemBody = {
        OrderId: "@{childOrder.id}",
        Product2Id: src.Product2Id,
        Quantity: line.qty,
      };
      if (src.PricebookEntryId) itemBody.PricebookEntryId = src.PricebookEntryId;
      if (src.UnitPrice != null) itemBody.UnitPrice = src.UnitPrice;
      if (src.Description) itemBody.Description = src.Description;
      if (src.Color__c != null) itemBody.Color__c = src.Color__c;
      if (src.Size__c != null) itemBody.Size__c = src.Size__c;
      compositeRequest.push({
        method: "POST",
        url: `${base}/OrderItem`,
        referenceId: `item${i}`,
        body: itemBody,
      });
    });

    // Running total: ADD this run's misprint+damaged count to whatever the
    // order already carries, rather than overwriting it outright the way
    // the Flow's single-run accumulator did -- so a second reprint against
    // the same order doesn't erase the first one's count. Documented
    // deviation from the source Flow; see PRODUCTION-ERROR-REPRINT-ANALYSIS.md.
    const runTotal = lines.reduce((sum, l) => sum + l.qty, 0);
    const priorTotal = Number(originalOrder.TotalQtyMisprints__c) || 0;
    const originalPatchBody = {
      Misprint_Details__c: misprintDetails || null,
      TotalQtyMisprints__c: priorTotal + runTotal,
    };
    if (by) originalPatchBody.Last_Updated_By__c = by;

    compositeRequest.push({
      method: "PATCH",
      url: `${base}/Order/${orderId}`,
      referenceId: "originalOrderPatch",
      body: originalPatchBody,
    });

    const resp = await sfFetch(env, `/services/data/${v}/composite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allOrNone: true, compositeRequest }),
    });
    const data = await resp.json();

    const subResults = Array.isArray(data.compositeResponse) ? data.compositeResponse : [];
    const codeOf = (r) => {
      const b = r && r.body;
      if (Array.isArray(b) && b[0]) return b[0].errorCode || "";
      if (b && b.errorCode) return b.errorCode;
      return "";
    };
    const isErr = (r) => r.httpStatusCode < 200 || r.httpStatusCode >= 300;
    const errored = subResults.filter(isErr);
    const realFailure = errored.find((r) => codeOf(r) !== "PROCESSING_HALTED") || errored[0] || null;

    if (!resp.ok || realFailure) {
      console.error("reprint: composite create failed", resp.status, JSON.stringify(data));
      return Response.json(
        {
          error: "create_failed",
          failedRef: realFailure ? realFailure.referenceId : null,
          detail: realFailure ? realFailure.body : data,
          all: subResults.map((r) => ({ referenceId: r.referenceId, httpStatusCode: r.httpStatusCode, body: r.body })),
        },
        { status: 502 },
      );
    }

    const byRef = (ref) => subResults.find((r) => r.referenceId === ref)?.body?.id ?? null;
    return Response.json(
      {
        ok: true,
        childOrderId: byRef("childOrder"),
        orderItemIds: lines.map((_, i) => byRef(`item${i}`)).filter(Boolean),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
