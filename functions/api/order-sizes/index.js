/**
 * GET /api/order-sizes?quoteId=<15-or-18-char SF Id>
 *
 * Returns the QuoteLineItem rows for one quote, so the front end can pivot
 * them into a size breakdown. Read-only: it only ever runs this one SELECT.
 *
 * SECURITY: quoteId comes from the client, so unlike /api/orders (whose SOQL
 * is fully hard-coded) this endpoint interpolates a value into the WHERE
 * clause. We therefore validate it against the strict Salesforce Id shape
 * (15 or 18 alphanumeric chars) and reject anything else BEFORE building the
 * query -- that blocks SOQL injection through the parameter. Note this shares
 * the same public exposure as /api/orders and is covered by the pending
 * Cloudflare Access lockdown, not by anything added here.
 *
 * FIELDS: each QuoteLineItem is ONE size of one garment. Rows with a blank
 * Size__c are non-garment lines (fees/upcharges) and are filtered out on the
 * front end, not here, so the raw data stays intact for other uses.
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
  "SortOrder",
  "Product2.Name",
  "Design__r.Name",
];

export async function onRequestGet({ env, request }) {
  try {
    const quoteId = new URL(request.url).searchParams.get("quoteId") || "";

    if (!SF_ID.test(quoteId)) {
      return jsonError("invalid_quote_id", 400);
    }

    const soql =
      `SELECT ${FIELDS.join(", ")} FROM QuoteLineItem ` +
      `WHERE QuoteId = '${quoteId}' ORDER BY SortOrder`;
    const path =
      `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;

    const resp = await sfFetch(env, path);
    const data = await resp.json();

    if (!resp.ok) {
      console.error("QuoteLineItem query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }

    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
