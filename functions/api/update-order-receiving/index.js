/**
 * POST /api/update-order-receiving
 * Body: { "orderId": "<15/18-char SF Id>", "status": "<value>", "missing": "<text?>" }
 *
 * The GARMENT count-in station writes the standard Order directly (no pre-prod
 * item / production method). Sets Receiving_Status__c, and manages the free-text
 * "missing count-in" note: it's kept only while the order is at the "Partial"
 * stage, and cleared otherwise — matching how the Salesforce box disappears once
 * an order moves to Counted In / Staged.
 *
 * Gated on the signed station token; only a station whose config is source:"order"
 * (i.e. garment) may call it. The order Id is shape-validated and the status must
 * be one the station config allows.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { STATION_CONFIG } from "../_station.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export async function onRequestPost({ env, request }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_body", 400);
    }

    const station = String(body.station || "").toLowerCase();
    const cfg = STATION_CONFIG[station];
    if (!cfg || cfg.source !== "order") return jsonError("station_not_configured", 400);

    const orderId = String(body.orderId || "");
    const status = String(body.status || "");
    const missing = body.missing == null ? "" : String(body.missing);

    if (!SF_ID.test(orderId)) return jsonError("invalid_order_id", 400);
    if (!cfg.statuses.includes(status)) return jsonError("invalid_status", 400);

    const payload = { [cfg.field]: status };

    // Missing-count note: keep it only at the "Partial" stage; clear it (null)
    // for every other status so a stale count doesn't linger.
    if (cfg.missingField) {
      payload[cfg.missingField] = status === cfg.missingAtStage ? missing : null;
    }

    const path = `/services/data/${apiVersion(env)}/sobjects/Order/${orderId}`;
    const resp = await sfFetch(env, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // A successful Salesforce sObject PATCH returns 204 No Content.
    if (!resp.ok && resp.status !== 204) {
      let detail = "";
      try {
        detail = JSON.stringify(await resp.json());
      } catch {
        /* body may be empty */
      }
      console.error("update-order-receiving failed", resp.status, detail);
      return jsonError("update_failed", resp.status);
    }

    return Response.json(
      { ok: true, orderId, status, missing: cfg.missingField ? payload[cfg.missingField] : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
