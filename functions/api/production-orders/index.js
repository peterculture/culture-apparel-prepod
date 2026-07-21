/**
 * GET /api/production-orders
 *
 * Same field list and mockup enrichment as /api/orders, but a different
 * WHERE clause: this one is for the Production Dashboard (index.html),
 * which needs every order currently at Ready for Print / In Production /
 * Post-Production / Completed -- i.e. anything with Order_Substatus__c
 * (the custom "Production Status" path) NOT at Pre-Production.
 *
 * WHY A SEPARATE ENDPOINT: /api/orders filters on the standard `Status`
 * field (`WHERE Status = 'Pre-Production'`), which is correct for the
 * Pre-Production Dashboard but was also being reused here. `Status` is a
 * standard order-fulfillment field that advances on its own (e.g. to
 * "Enter Tracking") once shipping/tracking info is entered on the order --
 * completely independent of Order_Substatus__c, our custom production
 * pipeline field. An order sitting at Order_Substatus__c = "Ready for
 * Print" or "Production" can have its standard Status move to "Enter
 * Tracking" (from Bulk Ship / Combine Shipments, etc.) well before
 * production work is actually done, which silently dropped it out of
 * /api/orders and made it vanish from every tab on this dashboard.
 * Confirmed on Order 00013456, 2026-07-14: Order_Substatus__c =
 * "Ready for Print" but Status = "Enter Tracking".
 *
 * Filtering on Order_Substatus__c directly instead sidesteps that
 * altogether -- this endpoint doesn't care what the standard Status field
 * is doing. /api/orders (used by pre-production.html) is left untouched.
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

export async function onRequestGet({ env }) {
  try {
    const soql =
      `SELECT ${FIELDS.join(", ")} FROM Order ` +
      `WHERE Order_Substatus__c != null AND Order_Substatus__c != 'Pre-Production' ` +
      `ORDER BY Print_Date__c ASC`;
    const path =
      `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;
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
        // records identically.
        const soqlPM =
          `SELECT Id, Order__c, Type__c, Placement__c, Status__c, Vendor__r.Name, ` +
          `Films_Printed__c, Screens_Completed__c, Mix_Inks__c, Digitize_File__c, ` +
          `Thread_Color_Materials__c, Transfers_Received__c, Transfers_Ready__c ` +
          `FROM Production_Method__c WHERE Order__c IN (${quoted})`;
        const pathPM = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soqlPM)}`;
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
