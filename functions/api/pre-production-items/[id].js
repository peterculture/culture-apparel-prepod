/**
 * PATCH /api/pre-production-items/<itemId>
 *
 * Updates the editable fields of ONE Pre_Production_Item__c from the worker
 * board. The browser sends a small JSON object with any subset of allowed
 * fields; anything not on the allow-list is ignored, and every restricted
 * picklist value is validated server-side before the write.
 *
 * Body example:
 *   { "Status__c": "Ready", "Screen_Sub_Status__c": "Ready for Print",
 *     "Mesh_Count__c": "125", "Notes__c": "..." }
 *
 * NOTE: Type__c is intentionally NOT editable (an item's type is fixed at
 * creation). Sub-status fields are validated only against their own picklist.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { rollupItemToOrder } from "../_ppi-checklist.js";
import { statusForSubStatus } from "../_station.js";

// If any of these change, the item may have just become (or stopped being)
// "ready" -- worth recomputing the parent Order's checklist boxes.
const ROLLUP_TRIGGER_FIELDS = new Set([
  "Status__c",
  "Screen_Sub_Status__c",
  "Ink_Sub_Status__c",
  "Transfers_Sub_Status__c",
]);

// Sub-status fields that drive a Status__c roll-up (see statusForSubStatus in
// _station.js). This board edits one field at a time (see setItemField in
// pre-production.html), so a PATCH here never carries both a sub-status AND
// an explicit Status__c -- but the explicit-Status__c check below guards it
// either way.
const SUBSTATUS_FIELDS = new Set([
  "Screen_Sub_Status__c",
  "Ink_Sub_Status__c",
  "Transfers_Sub_Status__c",
]);

// Restricted picklists — exact active values, confirmed 2026-07-02.
const PICKLISTS = {
  Status__c:               new Set(["Not Started", "In Progress", "Ready"]),
  Screen_Sub_Status__c:    new Set(["Not Clean", "Needs Emulsion", "Ready for Exposure", "Needs Tape", "Ready for Print"]),
  Ink_Sub_Status__c:       new Set(["Not Started", "Pantone Label Printed", "Mixing", "Mixed"]),
  Transfers_Sub_Status__c: new Set(["Not Received", "Transfers Received", "Transfers Cut/Ready"]),
  Mesh_Count__c:           new Set(["110", "125", "156", "180", "196", "230", "305"]),
  Transfer_Type__c:        new Set(["Screen Transfer", "Digital Transfer", "Sublimation", "Vinyl"]),
};
// Free-form fields (text/number) that need no picklist check.
const FREEFORM = new Set([
  "Pantone_Color__c",
  "Thread_Color__c",
  "Thread_Number__c",
  "Stitch_Count__c",
  "Notes__c",
  // Audit trail: free-text name of whoever made this change (see orders/[id].js
  // for why -- no per-worker Salesforce user exists yet). NOTE: this field must
  // exist on Pre_Production_Item__c (Text(80)) before this ships.
  "Last_Updated_By__c",
]);

const ITEM_OBJECT = "Pre_Production_Item__c";

function isSfId(s) {
  return typeof s === "string" && /^[a-zA-Z0-9]{15,18}$/.test(s);
}

/**
 * DELETE /api/pre-production-items/<itemId>
 *
 * Removes one Pre_Production_Item__c record -- lets a worker/manager undo an
 * item that was created by mistake (wrong type, duplicate, etc.). Salesforce
 * returns 204 No Content on a successful delete.
 */
export async function onRequestDelete({ env, params }) {
  try {
    const id = params && params.id;
    if (!isSfId(id)) return jsonError("bad_item_id", 400);

    const path = `/services/data/${apiVersion(env)}/sobjects/${ITEM_OBJECT}/${encodeURIComponent(id)}`;
    const resp = await sfFetch(env, path, { method: "DELETE" });

    if (resp.status === 204) {
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const detail = await resp.text();
    console.error("Item delete failed", resp.status, detail);
    return jsonError("delete_failed", resp.status);
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

export async function onRequestPatch({ env, request, params }) {
  const id = params && params.id;
  if (!isSfId(id)) return jsonError("bad_item_id", 400);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  if (!payload || typeof payload !== "object") return jsonError("invalid_body", 400);

  // Build a clean update body from ONLY the allowed fields.
  const body = {};
  for (const [field, value] of Object.entries(payload)) {
    if (PICKLISTS[field]) {
      // Allow clearing a field with "" / null; otherwise value must be valid.
      if (value === "" || value === null) {
        body[field] = null;
      } else if (PICKLISTS[field].has(String(value))) {
        body[field] = String(value);
      } else {
        return Response.json({ error: "bad_picklist_value", field, value }, { status: 400 });
      }
    } else if (FREEFORM.has(field)) {
      if (field === "Stitch_Count__c") {
        if (value === "" || value === null) { body[field] = null; }
        else {
          const n = Number(value);
          if (Number.isNaN(n)) return Response.json({ error: "bad_number", field }, { status: 400 });
          body[field] = n;
        }
      } else if (field === "Last_Updated_By__c") {
        body[field] = value ? String(value).slice(0, 80) : null;
      } else {
        body[field] = value === "" ? null : String(value);
      }
    }
    // else: field not allowed -> silently ignored
  }

  // If a sub-status just changed and the client didn't also explicitly send
  // Status__c, derive it here so it never drifts depending on which board
  // made the edit (station tablet vs. this worker/management board) -- single
  // source of truth is _station.js's STATION_CONFIG.statusMap.
  for (const field of Object.keys(body)) {
    if (SUBSTATUS_FIELDS.has(field) && body[field] != null && !("Status__c" in body)) {
      const derived = statusForSubStatus(field, body[field]);
      if (derived) body.Status__c = derived;
    }
  }

  if (Object.keys(body).length === 0) return jsonError("no_valid_fields", 400);

  try {
    const path = `/services/data/${apiVersion(env)}/sobjects/${ITEM_OBJECT}/${encodeURIComponent(id)}`;
    const resp = await sfFetch(env, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // SF returns 204 No Content on a successful update.
    if (resp.status === 204) {
      // If this write touched a status/sub-status field, the item may have
      // just crossed into (or out of) "ready" -- recompute the parent Order's
      // checklist box(es) from ALL sibling items of this type. Best-effort:
      // awaited so the order is in sync by the next fetch, but never fails
      // the item write that already succeeded.
      let rollup = null;
      if (Object.keys(body).some((f) => ROLLUP_TRIGGER_FIELDS.has(f))) {
        rollup = await rollupItemToOrder(env, id).catch((e) => { console.error("item rollup failed", e); return null; });
      }
      return Response.json({ ok: true, id, updated: Object.keys(body), rollup }, { headers: { "Cache-Control": "no-store" } });
    }
    let detail = null;
    try { detail = await resp.json(); } catch (_) {}
    console.error("Item update failed", resp.status, JSON.stringify(detail));
    return Response.json({ error: "update_failed", detail }, { status: 502 });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
