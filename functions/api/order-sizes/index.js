/**
 * GET /api/order-sizes?orderId=<15-or-18-char SF Id>
 *
 * Returns the OrderItem ("Order Products") rows for one order, so the front
 * end can pivot them into a size breakdown. Read-only: one SELECT, nothing else.
 *
 * Source is now the Order itself (OrderItem), NOT the quote. The old
 * Order -> Opportunity -> SyncedQuoteId -> QuoteLineItem chain is gone: size,
 * garment, color and quantity all hang directly off the order's products.
 *
 * SECURITY: orderId comes from the client, so it is validated against the
 * strict Salesforce Id shape (15 or 18 alphanumeric chars) before it is ever
 * placed in the WHERE clause -- that blocks SOQL injection through the param.
 * Same public exposure as /api/orders; covered by the pending Access lockdown.
 *
 * Each OrderItem is ONE size of one garment. Any row with a blank Size__c is
 * treated as a non-garment line on the front end (kept out of the grid), so
 * the raw rows are returned intact.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

const FIELDS = [
  "Id",
  "Size__c",
  "Quantity",
  "UnitPrice",
  "Color__c",
  "Description",
  "Product2.Name",
  "Design__r.Name",
];

export async function onRequestGet({ env, request }) {
  try {
    const orderId = new URL(request.url).searchParams.get("orderId") || "";

    if (!SF_ID.test(orderId)) {
      return jsonError("invalid_order_id", 400);
    }

    const soql =
      `SELECT ${FIELDS.join(", ")} FROM OrderItem ` +
      `WHERE OrderId = '${orderId}'`;
    const path =
      `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;

    const resp = await sfFetch(env, path);
    const data = await resp.json();

    if (!resp.ok) {
      console.error("OrderItem query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }

    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
