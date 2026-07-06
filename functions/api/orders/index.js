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

const FIELDS = [
  "Id",
  "GOA_Order_Number__c",
  "Opportunity.SyncedQuoteId",
  "OrderNumber",
  "Customer_Order_Name__c",
  "Print_Date__c",
  "Account.Name",
  "Printer__r.Name", // <-- printer account drives the print method
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

    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
