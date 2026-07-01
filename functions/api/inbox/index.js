/**
 * GET /api/inbox
 *
 * Returns the manager inbox: Orders that are in Pre-Production but do NOT yet
 * have a Production Method attached. As soon as a method is created for an
 * order (via POST /api/production-methods), that order falls out of this list
 * on the next load — the semi-join below excludes any Order whose Id appears
 * as the Order__c master-detail parent of an existing Production_Method__c.
 *
 * Uses Order__c (the confirmed master-detail field) in the sub-select, so this
 * needs no child-relationship name. Same fixed-query, no-client-SOQL shape as
 * /api/orders — the browser can't run arbitrary queries.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const FIELDS = [
  "Id",
  "OrderNumber",
  "GOA_Order_Number__c",
  "Name",          // verify this exists on Order in your org (same caveat as /api/orders)
  "Print_Date__c",
  "Account.Name",
];

export async function onRequestGet({ env }) {
  try {
    const soql =
      `SELECT ${FIELDS.join(", ")} FROM Order ` +
      `WHERE Status = 'Pre-Production' ` +
      `AND Id NOT IN (SELECT Order__c FROM Production_Method__c) ` +
      `ORDER BY Print_Date__c ASC`;
    const path =
      `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;
    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Inbox query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
