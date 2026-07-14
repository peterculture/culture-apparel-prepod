/**
 * GET  /api/packaging?orderId=<Order Id>
 *   Lists Packaging__c records for one order -- this is the "Packaging"
 *   related list in Salesforce (object description: "Stores detailed box
 *   information associated with an order, including quantity, type, weight,
 *   label ID, notes, status, and timestamps"). One row per physical box/bag
 *   packed for the order, its type, and how many garments are inside it.
 *
 * POST /api/packaging
 *   Logs a new package against an order (creates one Packaging__c record).
 *   Body: { orderId, Packaging_Type__c, Quantity__c }
 *   Packaging_Type__c must be one of the confirmed active picklist values
 *   below (fetched via ui-api/object-info, 2026-07-14). Order__c is the
 *   master-detail lookup back to Order; Name (the "Packaging ID") is an
 *   auto-number assigned by Salesforce on insert.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

const PACKAGING_TYPES = new Set([
  "Culture Box (22x16x12)",
  "Hat Box (26x8x6)",
  "Large Otto Box (27x17x20)",
  "Small White (12x10x8)",
  "Small Brown (12x8x5)",
  "Poly Bag (14x12x3)",
  "Cart",
]);

const FIELDS = [
  "Id",
  "Name",
  "Packaging_Type__c",
  "Quantity__c",
  "Packaging_Weight__c",
  "Notes__c",
  "CreatedDate",
];

export async function onRequestGet({ env, request }) {
  try {
    const orderId = new URL(request.url).searchParams.get("orderId") || "";
    if (!SF_ID.test(orderId)) return jsonError("invalid_order_id", 400);

    const soql =
      `SELECT ${FIELDS.join(", ")} FROM Packaging__c ` +
      `WHERE Order__c = '${orderId}' ORDER BY CreatedDate DESC`;
    const path = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;

    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Packaging query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    if (!body || typeof body !== "object") return jsonError("invalid_body", 400);

    const orderId = body.orderId || "";
    if (!SF_ID.test(orderId)) return jsonError("invalid_order_id", 400);

    const type = body.Packaging_Type__c;
    if (!PACKAGING_TYPES.has(type)) return jsonError("bad_packaging_type", 400);

    const qty = Number(body.Quantity__c);
    if (!Number.isFinite(qty) || qty <= 0) return jsonError("bad_quantity", 400);

    const payload = { Order__c: orderId, Packaging_Type__c: type, Quantity__c: qty };

    const path = `/services/data/${apiVersion(env)}/sobjects/Packaging__c`;
    const resp = await sfFetch(env, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.success === false) {
      console.error("Packaging create failed", resp.status, JSON.stringify(data));
      return jsonError("create_failed", resp.status || 502);
    }
    return Response.json(
      { ok: true, id: data.id },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
