/**
 * GET /api/orders
 *
 * Runs the fixed SOQL query for production-pipeline orders and returns the raw
 * Salesforce query response to the browser. Because the query is hard-coded
 * here (not passed in from the client), the browser cannot run arbitrary SOQL.
 *
 * WHY THE FILTER CHANGED (2026-07-20): the dashboards' columns are driven by
 * Order_Substatus__c (Pre-Production / Ready for Print / In Production /
 * Post-Production / Completed), NOT by the standard Status field. The old
 * filter `WHERE Status = 'Pre-Production'` dropped any order whose standard
 * Status had moved on (e.g. an order sitting at substatus "Post-Production"
 * whose Status is no longer "Pre-Production") -- so those orders silently
 * vanished from the board. Filtering on `Order_Substatus__c != null` returns
 * every order that is anywhere in the production pipeline and lets the front
 * end place each one by its substatus. If you ever need to scope it tighter,
 * filter on an explicit set instead, e.g.:
 *   WHERE Order_Substatus__c IN
 *     ('Pre-Production','Ready for Print','Production','Post-Production','Completed')
 * (note: the "In Production" picklist entry's stored value is "Production").
 *
 * NOTE ON FIELDS: adjust the SELECT list to match your org's exact API names.
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
  "Status", // <-- standard field; controlling field for Order_Substatus__c
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
      `WHERE Order_Substatus__c != null ORDER BY Print_Date__c ASC`;
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

    // Annotate whether each order already has a Production_Method__c. Orders
    // in Pre-Production with none yet should only be worked from the
    // Management inbox (see /api/inbox) -- pre-production.html's worker board
    // uses this flag to hide them until a manager sets one up. Same
    // second-query-then-Map pattern as the mockup lookup above; fails open
    // (defaults to visible) so a transient query error never hides real orders.
    const orderIds = (data.records || []).map((r) => r.Id).filter(Boolean);
    if (orderIds.length) {
      try {
        const quoted = orderIds.map((oid) => `'${oid}'`).join(",");
        const soqlPM =
          `SELECT Order__c FROM Production_Method__c WHERE Order__c IN (${quoted})`;
        const pathPM = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soqlPM)}`;
        const respPM = await sfFetch(env, pathPM);
        const dataPM = await respPM.json();
        if (respPM.ok) {
          const withMethod = new Set((dataPM.records || []).map((r) => r.Order__c));
          (data.records || []).forEach((r) => {
            r.HasProductionMethod = withMethod.has(r.Id);
          });
        } else {
          console.error("Production method check failed", respPM.status, JSON.stringify(dataPM));
          (data.records || []).forEach((r) => { r.HasProductionMethod = true; });
        }
      } catch (e) {
        console.error("Production method check error", e);
        (data.records || []).forEach((r) => { r.HasProductionMethod = true; });
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
