/**
 * GET /api/production-orders
 *
 * Same field list and mockup enrichment as /api/orders, but a different
 * WHERE clause: this one is for the Production Dashboard (index.html),
 * which needs every order with at least one Production_Method__c currently
 * at Ready for Print / In Production / Post-Production / Completed.
 *
 * WHY A SEPARATE ENDPOINT: /api/orders filters on the standard `Status`
 * field (`WHERE Status = 'Pre-Production'`), which is correct for the
 * Pre-Production Dashboard but was also being reused here. `Status` is a
 * standard order-fulfillment field that advances on its own (e.g. to
 * "Enter Tracking") once shipping/tracking info is entered on the order --
 * completely independent of the production pipeline. An order that's still
 * actively in production can have its standard Status move to "Enter
 * Tracking" (from Bulk Ship / Combine Shipments, etc.) well before
 * production work is actually done, which silently dropped it out of
 * /api/orders and made it vanish from every tab on this dashboard.
 * Confirmed on Order 00013456, 2026-07-14.
 *
 * GATING LOGIC (2026-07-21): this now gates on Production_Method__c.Status__c
 * directly instead of Order.Order_Substatus__c. Order_Substatus__c is a
 * ROLLED-UP field (see _pm-rollup.js) that always reflects whichever sibling
 * method is LEAST advanced -- so a multi-method order (e.g. a Screen Print
 * method still sitting in Pre-Production alongside a Heat Press method
 * already in Post-Production) used to roll the *entire order* back to
 * "Pre-Production" and vanish from this whole dashboard, hiding the Heat
 * Press card from the floor even though it was actively in production. This
 * is the exact same failure mode as the native Salesforce Kanban boards
 * being gated by a single Order.Printer__c -- one slow/unset sibling holding
 * the rest of the order hostage. Querying Production_Method__c directly for
 * "does this order have ANY method that's cleared Pre-Production on its own"
 * means each method's visibility here depends only on itself, matching what
 * already drives which column a card lands in (see stageOfMethod() in
 * ca-api.js). Falls back to the old order-level filter if the gating query
 * errors, so a transient failure degrades gracefully instead of blanking the
 * board. /api/orders (used by pre-production.html) is left untouched -- it
 * already filters per-method client-side and was never gated this way.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { fetchMockupsByOpportunity } from "../_mockup.js";

const FIELDS = [
  "Id",
  "GOA_Order_Number__c",
  "OpportunityId", // <-- used server-side to look up the Design__c mockup image
  "Opportunity.SyncedQuoteId",
  "OrderNumber",
  "Customer_Order_Name__c",
  "Print_Date__c",
  "Account.Name",
  "Printer__r.Name", // <-- printer account drives the print method
  "Status", // <-- standard field; NOT used to filter this query, see note above
  "Order_Substatus__c", // <-- "Production Status" path: Pre-Production, Ready for Print, In Production, Post-Production, Completed
  "Receiving_Status__c",
  "Partial_Check_in_Missing_Items__c", // <-- garment count-in board: missing note
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
  // Production Dashboard (In Production / Post-Production / shipping)
  "Print_Setup_Timer__c",
  "Production_Timer__c",
  "Misprint__c",
  "Misprint_Details__c",
  "TotalQtyMisprints__c",
  "Packaging_Count__c",
  "Production_Notes__c",
  "Shipping_Delivery__c", // <-- "Delivery Method" picklist
  "Shipping_Label_Printed__c",
  "ShippingAddress", // <-- compound address field, returns as a nested object
  "Special_Notes__c", // <-- Ready for Print card: Special Notes
  "Specifications_for_Printing__c", // <-- Ready for Print card: Specifications for Printing
  "(SELECT Product2.Name, Color__c, Size__c, Quantity FROM OrderItems)",
];

// Production_Method__c.Status__c values that mean "past Pre-Production" --
// kept in sync with STAGE_KEY in ca-api.js (which drives column placement)
// and PM_RANK in _pm-rollup.js. On Hold ranks the same as Pre-Production in
// both of those, so it's deliberately excluded here too: a method that's on
// hold shouldn't pull its order onto the production floor board.
const ADVANCED_PM_STATUSES = [
  "Ready for Print",
  "In Production",
  "Post-Production",
  "Completed",
];

export async function onRequestGet({ env }) {
  try {
    const v = apiVersion(env);

    // Ask Production_Method__c which orders actually qualify (see the
    // GATING LOGIC note above) instead of trusting the order-level rollup.
    // gateOrderIds stays null if the gating query itself fails, so the
    // fallback below can tell "found nothing" apart from "couldn't ask".
    let gateOrderIds = null;
    try {
      const statusList = ADVANCED_PM_STATUSES.map((s) => `'${s}'`).join(",");
      const gateSoql =
        `SELECT Order__c FROM Production_Method__c ` +
        `WHERE Status__c IN (${statusList}) AND Order__c != null`;
      const gatePath = `/services/data/${v}/query/?q=${encodeURIComponent(gateSoql)}`;
      const gateResp = await sfFetch(env, gatePath);
      if (gateResp.ok) {
        const gateData = await gateResp.json();
        gateOrderIds = Array.from(
          new Set((gateData.records || []).map((r) => r.Order__c).filter(Boolean)),
        );
      } else {
        console.error("Production method gating query failed", gateResp.status);
      }
    } catch (e) {
      console.error("Production method gating query error", e);
    }

    let soql;
    if (gateOrderIds && gateOrderIds.length) {
      const quotedGate = gateOrderIds.map((oid) => `'${oid}'`).join(",");
      soql =
        `SELECT ${FIELDS.join(", ")} FROM Order ` +
        `WHERE Id IN (${quotedGate}) ORDER BY Print_Date__c ASC`;
    } else if (gateOrderIds && gateOrderIds.length === 0) {
      // Gating query ran fine and genuinely found no orders past
      // Pre-Production -- an empty board is the correct answer, not a
      // failure, so skip straight to returning one.
      return Response.json(
        { totalSize: 0, done: true, records: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    } else {
      // Gating query itself failed -- fall back to the old order-level
      // filter so the board still shows *something* instead of erroring.
      soql =
        `SELECT ${FIELDS.join(", ")} FROM Order ` +
        `WHERE Order_Substatus__c != null AND Order_Substatus__c != 'Pre-Production' ` +
        `ORDER BY Print_Date__c ASC`;
    }

    const path = `/services/data/${v}/query/?q=${encodeURIComponent(soql)}`;
    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Salesforce query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }

    const mockups = await fetchMockupsByOpportunity(
      env,
      (data.records || []).map((r) => r.OpportunityId),
    );
    (data.records || []).forEach((r) => {
      r.DesignMockupUrl = mockups.get(r.OpportunityId) || null;
    });

    // Same Production_Method__c enrichment as /api/orders (see that file for
    // the full rationale): an order can have more than one method/placement
    // combo (e.g. screen print front+back plus a heat-press tag), so this
    // attaches the full list rather than a single inferred method. Fails
    // open (empty array) so a transient query error never breaks the board.
    const orderIds = (data.records || []).map((r) => r.Id).filter(Boolean);
    if (orderIds.length) {
      try {
        const quoted = orderIds.map((oid) => `'${oid}'`).join(",");
        // Same per-method checklist booleans as /api/orders -- see that
        // file for the full rationale. Not rendered on this board today,
        // but kept symmetric so both endpoints shape Production_Method__c
        // records identically. Placements__c (multi-select) + Placement__c
        // fallback: same reasoning as /api/orders.
        const soqlPM =
          `SELECT Id, Order__c, Type__c, Placement__c, Placements__c, Status__c, Vendor__r.Name, ` +
          `Films_Printed__c, Screens_Completed__c, Mix_Inks__c, Digitize_File__c, ` +
          `Thread_Color_Materials__c, Transfers_Received__c, Transfers_Ready__c ` +
          `FROM Production_Method__c WHERE Order__c IN (${quoted})`;
        const pathPM = `/services/data/${v}/query/?q=${encodeURIComponent(soqlPM)}`;
        const respPM = await sfFetch(env, pathPM);
        const dataPM = await respPM.json();
        if (respPM.ok) {
          const byOrder = new Map();
          (dataPM.records || []).forEach((pm) => {
            const arr = byOrder.get(pm.Order__c) || [];
            arr.push({
              Id: pm.Id,
              Type__c: pm.Type__c,
              Placement__c: pm.Placement__c || null,
              Placements: pm.Placements__c
                ? pm.Placements__c.split(";").filter(Boolean)
                : (pm.Placement__c ? [pm.Placement__c] : []),
              Status__c: pm.Status__c,
              Vendor: (pm.Vendor__r && pm.Vendor__r.Name) || null,
              Films_Printed__c: !!pm.Films_Printed__c,
              Screens_Completed__c: !!pm.Screens_Completed__c,
              Mix_Inks__c: !!pm.Mix_Inks__c,
              Digitize_File__c: !!pm.Digitize_File__c,
              Thread_Color_Materials__c: !!pm.Thread_Color_Materials__c,
              Transfers_Received__c: !!pm.Transfers_Received__c,
              Transfers_Ready__c: !!pm.Transfers_Ready__c,
            });
            byOrder.set(pm.Order__c, arr);
          });
          (data.records || []).forEach((r) => {
            r.ProductionMethods = byOrder.get(r.Id) || [];
          });
        } else {
          console.error("Production method fetch failed", respPM.status, JSON.stringify(dataPM));
          (data.records || []).forEach((r) => { r.ProductionMethods = []; });
        }
      } catch (e) {
        console.error("Production method fetch error", e);
        (data.records || []).forEach((r) => { r.ProductionMethods = []; });
      }
    }

    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
