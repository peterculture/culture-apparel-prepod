/**
 * GET /api/orders
 *
 * Runs the fixed SOQL query for Pre-Production orders and returns the raw
 * Salesforce query response to the browser. Because the query is hard-coded
 * here (not passed in from the client), the browser cannot run arbitrary SOQL.
 *
 * NOTE ON FIELDS: adjust the SELECT list to match your org's exact API names.
 * In particular, the project notes list a `Name` (customer) field on Order --
 * the standard Order object does not have a `Name` field, so if your org errors
 * on it, replace it with whatever field actually holds the customer name
 * (e.g. a lookup like Account.Name, or a custom field).
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
  "Production_Timer__c",
  "Misprint__c",
  "Misprint_Details__c",
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
      `WHERE Status = 'Pre-Production' ORDER BY Print_Date__c ASC`;
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

    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
