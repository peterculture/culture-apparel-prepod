/**
 * GET /api/plans?q=<search>
 *
 * Type-ahead search for the "pick an existing Production Plan" option on the
 * manager form. ProductionPlan__c on Production_Method__c is a master-detail
 * lookup; this searches existing plans by their Name / auto-number (PP-0018).
 *
 * Fixed-shape query (no client SOQL): the browser only supplies a search
 * string, which is escaped and dropped into a LIKE. Returns up to 20 matches.
 *
 *   GET /api/plans?q=PP-001   ->  { records: [ { Id, Name }, ... ] }
 *
 * With no q (or q shorter than 2 chars) it returns the 20 most recently
 * created plans, so the dropdown isn't empty on first open.
 */
import { runQuery, jsonError } from "../_sf.js";

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
        `SELECT Id, Name FROM ProductionPlan__c ` +
        `WHERE Name LIKE '%${term}%' ` +
        `ORDER BY Name ASC LIMIT 20`;
    } else {
      soql =
        `SELECT Id, Name FROM ProductionPlan__c ` +
        `ORDER BY CreatedDate DESC LIMIT 20`;
    }

    // LIMIT 20 above already caps this well under one query batch, but
    // runQuery is used everywhere a query runs now for consistency -- see
    // _sf.js.
    const { ok, status, records: raw } = await runQuery(env, soql);
    if (!ok) {
      console.error("Plan search failed", status);
      return jsonError("query_failed", status);
    }
    const records = raw.map((r) => ({ Id: r.Id, Name: r.Name }));
    return Response.json({ records }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
