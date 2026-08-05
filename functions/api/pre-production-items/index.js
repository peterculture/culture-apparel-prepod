/**
 * GET  /api/pre-production-items?orderId=<Order Id>
 *   Returns all Pre_Production_Item__c records for that order's Production
 *   Method(s), so the worker board can list and edit them. Traverses
 *   Item -> Production_Method__c (lookup) -> Order__c.
 *
 * POST /api/pre-production-items
 *   Creates ONE Pre_Production_Item__c under an EXISTING Production_Method__c.
 *   Added 2026-07-29 so a manager/worker can add an item a board forgot back
 *   in the Management tab, straight from the Pre-Production or Production
 *   card drawer -- previously items could only be created as part of the
 *   whole Requirement -> Plan -> Method -> Items chain in
 *   production-methods/index.js's POST, all at once, at method-creation time.
 *
 *   Body:
 *     {
 *       "methodId": "a3V...",       // Production_Method__c Id (required)
 *       "type": "Screen",            // one of ALLOWED_ITEM_TYPES (required)
 *       "mesh": "125",                // Screen only, restricted picklist
 *       "pantone": "PMS 186",          // Ink only, free text
 *       "threadColor": "Navy",          // Thread only, free text
 *       "threadNumber": "40wt",          // Thread only, free text
 *       "stitchCount": 5000,              // Digitization only, number
 *       "transferType": "Vinyl",           // Transfer only, restricted picklist
 *       "by": "Anthony"                     // optional, stamped onto Last_Updated_By__c
 *     }
 *
 * PATCH /api/pre-production-items/<itemId>
 *   (handled in the [id].js sibling) — updates one item's editable fields.
 *
 * Fixed-shape query, no client SOQL: the browser supplies only an orderId,
 * which is validated as an SF Id and dropped into a bind.
 */
import { sfFetch, apiVersion, jsonError, runQuery } from "../_sf.js";

// Keep in sync with the same-named consts in production-methods/index.js --
// this is the same restricted set of item types/picklists, just for adding
// ONE item to a method that already exists instead of creating the whole
// method+items chain at once.
const ALLOWED_ITEM_TYPES   = new Set(["Screen", "Ink", "Thread", "Digitization", "Transfer"]);
const ALLOWED_MESH          = new Set(["110", "125", "156", "180", "196", "230", "305"]);
const ALLOWED_TRANSFER_TYPE = new Set(["Screen Transfer", "Digital Transfer", "Sublimation", "Vinyl"]);
const ITEM_STATUS_DEFAULT = "Not Started";

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
  "Production_Method__c",
  "Production_Method__r.Name",
  "Production_Method__r.Type__c",
];
// FIXED 2026-07-29 (round 1): removed Production_Method__r.Placement__c
// (the deprecated single-select field, superseded by Placements__c -- see
// production-methods/index.js). That field was never actually the problem,
// though -- pre-production-items still returned zero records for every
// order afterward.
//
// FIXED 2026-07-29 (round 2, actual root cause): the real blocker is
// Notes__c. Confirmed directly via an admin SOQL query in Setup (Developer
// Console) -- the exact query this endpoint builds fails to even PARSE
// ("ERROR at Row:1:Column:207", landing right on Notes__c) whenever
// Notes__c is in the SELECT list, and succeeds immediately once it's
// dropped. Root cause IS Field-Level Security: "View Field Accessibility"
// on Pre_Production_Item__c.Notes__c showed it Hidden for every single
// profile in the org, including System Administrator -- a query-time SOQL
// parse error is just how Salesforce surfaces a completely-hidden field,
// not a distinct restriction on Long Text Area fields in general (Notes__c
// on Production_Method__c queries fine). This FLS gap has since been
// closed (Notes__c is now Editable for all profiles, matching
// Mesh_Count__c), but Notes__c is dropped here anyway since nothing in
// pre-production.html ever reads or writes
// Pre_Production_Item__c.Notes__c (grepped the whole file -- only
// Order.Special_Notes__c is used, a different field entirely) -- no reason
// to re-add a field this endpoint doesn't need.

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

    // Naturally small (scoped to one order's own items), but runQuery is
    // used everywhere a query runs now for consistency -- see _sf.js.
    const { ok, status, records } = await runQuery(env, soql);
    if (!ok) {
      console.error("Item query failed", status);
      return jsonError("query_failed", status);
    }
    return Response.json(
      { totalSize: records.length, done: true, records },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

export async function onRequestPost({ env, request }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  if (!payload || typeof payload !== "object") return jsonError("invalid_body", 400);

  const methodId = payload.methodId;
  if (!isSfId(methodId)) return jsonError("missing_methodId", 400);

  const type = payload.type;
  if (!type || typeof type !== "string" || !ALLOWED_ITEM_TYPES.has(type)) {
    return jsonError("bad_item_type", 400);
  }
  if (type === "Screen" && payload.mesh != null && payload.mesh !== "" && !ALLOWED_MESH.has(String(payload.mesh))) {
    return Response.json({ error: "bad_mesh", detail: payload.mesh }, { status: 400 });
  }
  if (type === "Transfer" && payload.transferType != null && payload.transferType !== "" && !ALLOWED_TRANSFER_TYPE.has(payload.transferType)) {
    return Response.json({ error: "bad_transfer_type", detail: payload.transferType }, { status: 400 });
  }

  const by = (payload.by == null ? "" : String(payload.by)).trim().slice(0, 80);

  const body = {
    Production_Method__c: methodId,
    Type__c: type,
    Status__c: ITEM_STATUS_DEFAULT,
  };
  if (by) body.Last_Updated_By__c = by;
  if (type === "Screen") {
    if (payload.mesh) body.Mesh_Count__c = String(payload.mesh);
  } else if (type === "Ink") {
    if (payload.pantone) body.Pantone_Color__c = String(payload.pantone);
  } else if (type === "Thread") {
    if (payload.threadColor) body.Thread_Color__c = String(payload.threadColor);
    if (payload.threadNumber) body.Thread_Number__c = String(payload.threadNumber);
  } else if (type === "Digitization") {
    if (payload.stitchCount != null && payload.stitchCount !== "") {
      const n = Number(payload.stitchCount);
      if (!Number.isNaN(n)) body.Stitch_Count__c = n;
    }
  } else if (type === "Transfer") {
    if (payload.transferType) body.Transfer_Type__c = String(payload.transferType);
  }

  try {
    const path = `/services/data/${apiVersion(env)}/sobjects/Pre_Production_Item__c`;
    const resp = await sfFetch(env, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data || data.success === false) {
      console.error("Item create failed", resp.status, JSON.stringify(data));
      return Response.json({ error: "create_failed", detail: data }, { status: 502 });
    }

    return Response.json({ ok: true, id: data.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
