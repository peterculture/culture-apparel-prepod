/**
 * PATCH /api/production-runs/:id
 *
 * Updates ONE Production_Run__c -- powers the editable "Production Runs"
 * section inside a card's drawer on the pre-production board
 * (pre-production.html), added 2026-07-22 so a manager can revisit a run
 * after creation and change the press/schedule/quantity it was created with,
 * plus log its Actual Start/End once work actually begins/finishes.
 *
 * Body (send any subset -- only the keys present are written):
 *   {
 *     "pressId":        "001...",                    // Account Id, Type='Press'
 *     "scheduledStart":  "2026-07-25T14:00:00.000Z",  // ISO datetime
 *     "scheduledEnd":    "2026-07-25T17:00:00.000Z",  // ISO datetime
 *     "quantity": 48,                                  // positive integer
 *     "actualStart": "2026-07-25T14:05:00.000Z",       // ISO datetime, OR
 *                     "" / null to CLEAR the field
 *     "actualEnd":   "2026-07-25T17:20:00.000Z"        // same clear rule
 *   }
 *
 * scheduledStart/scheduledEnd are sent together by the UI every save (same
 * as the create endpoint) so the end>=start check below only fires when
 * both are present in one request. actualStart/actualEnd are independently
 * nullable -- the drawer lets a manager blank out either date/time pair to
 * clear it (e.g. correcting a mis-logged Actual Start) without touching the
 * other. Field names match production-runs/index.js exactly -- see that
 * file's docblock for the Quantity_Planned_c__c naming quirk.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const PR_OBJECT = "Production_Run__c";
const PR_PRESS_FIELD = "Press__c";
const PR_SCHED_START_FIELD = "Scheduled_Start__c";
const PR_SCHED_END_FIELD = "Scheduled_End__c";
const PR_QTY_FIELD = "Quantity_Planned_c__c";
const PR_ACTUAL_START_FIELD = "Actual_Start__c";
const PR_ACTUAL_END_FIELD = "Actual_End__c";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

function parseIso(v) {
  if (v == null || v === "") return undefined; // key present but blank -- caller decides what that means
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d; // null signals "provided but invalid"
}

export async function onRequestPatch({ params, request, env }) {
  try {
    const id = params && params.id;
    if (!SF_ID.test(id)) return jsonError("invalid_id", 400);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    if (!body || typeof body !== "object") return jsonError("invalid_body", 400);

    const payload = {};

    if ("pressId" in body) {
      if (!body.pressId || !SF_ID.test(body.pressId)) return jsonError("bad_pressId", 400);
      payload[PR_PRESS_FIELD] = body.pressId;
    }

    if ("scheduledStart" in body || "scheduledEnd" in body) {
      const start = parseIso(body.scheduledStart);
      const end = parseIso(body.scheduledEnd);
      if (start === null) return jsonError("bad_scheduledStart", 400);
      if (end === null) return jsonError("bad_scheduledEnd", 400);
      if (start && end && end.getTime() < start.getTime()) {
        return jsonError("scheduledEnd_before_scheduledStart", 400);
      }
      if (start) payload[PR_SCHED_START_FIELD] = start.toISOString();
      if (end) payload[PR_SCHED_END_FIELD] = end.toISOString();
    }

    if ("quantity" in body) {
      const n = Number(body.quantity);
      if (!Number.isFinite(n) || n <= 0 || n > 999999 || Math.floor(n) !== n) {
        return jsonError("bad_quantity", 400);
      }
      payload[PR_QTY_FIELD] = n;
    }

    // Actual Start/End: nullable. Empty string/null CLEARS the field (a
    // manager un-logging a mistaken entry); a valid ISO string sets it; the
    // key being absent entirely leaves it untouched.
    if ("actualStart" in body) {
      if (body.actualStart == null || body.actualStart === "") {
        payload[PR_ACTUAL_START_FIELD] = null;
      } else {
        const d = parseIso(body.actualStart);
        if (!d) return jsonError("bad_actualStart", 400);
        payload[PR_ACTUAL_START_FIELD] = d.toISOString();
      }
    }
    if ("actualEnd" in body) {
      if (body.actualEnd == null || body.actualEnd === "") {
        payload[PR_ACTUAL_END_FIELD] = null;
      } else {
        const d = parseIso(body.actualEnd);
        if (!d) return jsonError("bad_actualEnd", 400);
        payload[PR_ACTUAL_END_FIELD] = d.toISOString();
      }
    }
    if (payload[PR_ACTUAL_START_FIELD] && payload[PR_ACTUAL_END_FIELD]) {
      if (new Date(payload[PR_ACTUAL_END_FIELD]).getTime() < new Date(payload[PR_ACTUAL_START_FIELD]).getTime()) {
        return jsonError("actualEnd_before_actualStart", 400);
      }
    }

    if (Object.keys(payload).length === 0) return jsonError("no_valid_fields", 400);

    const path = `/services/data/${apiVersion(env)}/sobjects/${PR_OBJECT}/${id}`;
    const resp = await sfFetch(env, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.status !== 204) {
      const detail = await resp.text();
      console.error("Production run update failed", resp.status, detail);
      return jsonError("update_failed", resp.status);
    }

    return Response.json(
      { ok: true, id, updated: Object.keys(payload) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
