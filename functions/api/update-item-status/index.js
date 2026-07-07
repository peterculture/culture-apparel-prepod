/**
 * POST /api/update-item-status
 * Body: { "itemId": "<15/18-char SF Id>", "subStatus": "<value>" }
 *
 * Advances one Pre-Production Item's sub-status for the caller's station, and
 * sets the rolled-up Status__c in the SAME write. No Salesforce flow maintains
 * Status__c (confirmed 2026-07-07), so this endpoint owns the roll-up: e.g.
 * ink "Mixed" => Status__c "Ready", which drops the item off the schedule.
 *
 * WRITE endpoint -- the one that must sit behind the Cloudflare Access lockdown
 * before it goes live. Layers of protection here:
 *   - gated on the signed station token (401 otherwise)
 *   - itemId shape-validated against the strict SF Id pattern
 *   - subStatus must be a value the caller's station config allows, so an ink
 *     token can only ever write ink sub-statuses
 *   - Status__c is derived server-side, never accepted from the client
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { verifyStationToken, STATION_CONFIG } from "../_station.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export async function onRequestPost({ env, request }) {
  try {
    const station = await verifyStationToken(env, request);
    if (!station) return jsonError("unauthorized", 401);

    const cfg = STATION_CONFIG[station];
    if (!cfg) return jsonError("station_not_configured", 400);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_body", 400);
    }
    const itemId = String(body.itemId || "");
    const subStatus = String(body.subStatus || "");

    if (!SF_ID.test(itemId)) return jsonError("invalid_item_id", 400);
    if (!cfg.subStatusFlow.includes(subStatus)) {
      return jsonError("invalid_sub_status", 400);
    }

    // Always write the sub-status the worker set.
    const payload = { [cfg.subStatusField]: subStatus };

    // Status__c: if a Salesforce flow rolls it up from the sub-status
    // (cfg.statusViaFlow), DON'T write it here -- writing the sub-status
    // triggers the flow, and letting the flow own Status keeps a single source
    // of truth. Otherwise (e.g. ink, no flow) derive and write it ourselves.
    let rolledStatus = null;
    if (!cfg.statusViaFlow) {
      rolledStatus = cfg.statusMap[subStatus];
      if (!rolledStatus) return jsonError("unmapped_sub_status", 400);
      payload.Status__c = rolledStatus;
    }

    // HELPER-CONVENTION NOTE: order-sizes only ever calls sfFetch(env, path)
    // for GETs, so this assumes sfFetch forwards a 3rd options arg (method /
    // headers / body) to the underlying fetch -- the usual shape for such a
    // wrapper. If _sf.js differs, this single call is what needs to match it.
    const path =
      `/services/data/${apiVersion(env)}/sobjects/Pre_Production_Item__c/${itemId}`;
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
      console.error("update-item-status failed", resp.status, detail);
      return jsonError("update_failed", resp.status);
    }

    return Response.json(
      { ok: true, itemId, subStatus, status: rolledStatus },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
