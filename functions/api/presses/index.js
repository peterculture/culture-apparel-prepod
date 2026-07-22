/**
 * GET /api/presses?q=<search>
 *
 * Type-ahead search for the Press picker on the "Create Production Run"
 * modal (pre-production.html). Press__c on Production_Run__c is a lookup to
 * Account, scoped to the shop's press/machine records specifically --
 * Account.Type = 'Press' (Setup -> Object Manager -> Account -> Fields ->
 * Type, Record Type: Vendor). Confirmed live 2026-07-22 against the 5
 * equipment accounts created that day: Press 1, Press 2, Embroidery Machine,
 * Hat Press, Shirt Press.
 *
 * Same fixed-shape-query pattern as ../vendors/index.js (no client SOQL) --
 * this just adds the Type filter so the picker only ever shows actual
 * press/machine accounts, not every Account in the org.
 *
 *   GET /api/presses?q=press   ->  { records: [ { Id, Name }, ... ] }
 *
 * With no q (or q shorter than 2 chars), returns up to 20 press accounts
 * sorted alphabetically -- there are only a handful of these, so a stable
 * A-Z list is more useful than "recently used".
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

// SOQL string-literal escape: backslash and single-quote only.
function soqlEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();

    let soql;
    if (q.length >= 2) {
      const term = soqlEscape(q);
      soql =
        `SELECT Id, Name FROM Account ` +
        `WHERE Type = 'Press' AND Name LIKE '%${term}%' ` +
        `ORDER BY Name ASC LIMIT 20`;
    } else {
      soql =
        `SELECT Id, Name FROM Account ` +
        `WHERE Type = 'Press' ` +
        `ORDER BY Name ASC LIMIT 20`;
    }

    const path = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;
    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Press search failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }
    const records = (data.records || []).map((r) => ({ Id: r.Id, Name: r.Name }));
    return Response.json({ records }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
