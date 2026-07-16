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
      return Response.json({ ok: true, id, updated: Object.keys(body) }, { headers: { "Cache-Control": "no-store" } });
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
