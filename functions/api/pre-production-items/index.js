/**
 * GET  /api/pre-production-items?orderId=<Order Id>
 *   Returns all Pre_Production_Item__c records for that order's Production
 *   Method(s), so the worker board can list and edit them. Traverses
 *   Item -> Production_Method__c (lookup) -> Order__c.
 *
 * PATCH /api/pre-production-items/<itemId>
 *   (handled in the [id].js sibling) — updates one item's editable fields.
 *
 * Fixed-shape query, no client SOQL: the browser supplies only an orderId,
 * which is validated as an SF Id and dropped into a bind.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

// Everything the worker edit panel needs to display/edit.
const ITEM_FIELDS = [
  "Id",
  "Name",
  "Type__c",
  "Status__c",
  "Screen_Sub_Status__c",
  "Ink_Sub_Status__c",
  "Transfers_Sub_Status__c",
  "Mesh_Count__c",
  "Pantone_Color__c",
  "Thread_Color__c",
  "Thread_Number__c",
  "Stitch_Count__c",
  "Transfer_Type__c",
  "Notes__c",
  "Production_Method__c",
  "Production_Method__r.Name",
  "Production_Method__r.Type__c",
];
// FIXED 2026-07-29: this used to also select Production_Method__r.Placement__c
// (the deprecated single-select field, superseded by Placements__c -- see
// production-methods/index.js). Nothing in pre-production.html ever read it
// off these item records (only _station.js's station-board queries actually
// use Placement__c, and those are untouched), so it was dead weight here --
// but it's exactly the kind of field that gets missed when granting FLS to
// the Client Credentials integration user, and that's what was happening:
// this endpoint's query was failing outright (INSUFFICIENT_ACCESS on that
// field for the API user), so /api/pre-production-items returned zero
// records for every order, and the app showed "no items" no matter what was
// actually created. Dropping the unused field here removes the failure
// without touching FLS at all.

// Loose SF Id sanity check (15 or 18 char alphanumeric).
function isSfId(s) {
  return typeof s === "string" && /^[a-zA-Z0-9]{15,18}$/.test(s);
}

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);
    const orderId = (url.searchParams.get("orderId") || "").trim();
    if (!isSfId(orderId)) return jsonError("bad_orderId", 400);

    const soql =
      `SELECT ${ITEM_FIELDS.join(", ")} FROM Pre_Production_Item__c ` +
      `WHERE Production_Method__r.Order__c = '${orderId}' ` +
      `ORDER BY Production_Method__c, Type__c, Name`;
    const path = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;

    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Item query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
