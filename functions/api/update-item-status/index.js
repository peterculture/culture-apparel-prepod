/**
 * POST /api/update-item-status
 * Body: { "station": "<name>", "itemId": "<15/18-char SF Id>", "subStatus": "<value>", "by": "<worker name>" }
 *
 * Advances one Pre-Production Item's sub-status for the given station, and
 * sets the rolled-up Status__c in the SAME write when the station has no flow.
 *
 * "by" is an optional free-text worker name (captured client-side at station
 * login, since a station tablet is shared by whoever's PIN unlocked it, not
 * tied to one person) -- stamped onto Last_Updated_By__c alongside the
 * sub-status write, so there's an audit trail of who advanced what. NOTE:
 * Pre_Production_Item__c.Last_Updated_By__c (Text(80)) must exist in
 * Salesforce before this ships, or the PATCH will fail with INVALID_FIELD.
 *
 * WRITE endpoint -- open (no login); the real perimeter is Cloudflare Access in
 * front of /api/*. Still validated:
 *   - station must map to a known config (else rejected)
 *   - itemId shape-validated against the strict SF Id pattern
 *   - subStatus must be a value that station's config allows
 *   - Status__c is derived server-side, never accepted from the client
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
    if (!cfg || !cfg.subStatusFlow) return jsonError("station_not_configured", 400);

    const itemId = String(body.itemId || "");
    const subStatus = String(body.subStatus || "");

    if (!SF_ID.test(itemId)) return jsonError("invalid_item_id", 400);
    if (!cfg.subStatusFlow.includes(subStatus)) {
      return jsonError("invalid_sub_status", 400);
    }

    // Always write the sub-status the worker set.
    const payload = { [cfg.subStatusField]: subStatus };

    // Optional worker-name attribution (see file header). Trimmed/capped
    // server-side regardless of what the client sends.
    const by = (body.by == null ? "" : String(body.by)).trim();
    if (by) payload.Last_Updated_By__c = by.slice(0, 80);

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

    // Optional cross-object roll-up onto the standard Order (transfers use this
    // to drive the main dashboard's heat-press checkboxes). Best-effort: the
    // item update already succeeded, so a roll-up failure is logged, not fatal.
    let rollup = null;
    if (cfg.orderRollup) {
      try {
        rollup = await rollupOrder(env, cfg, itemId);
      } catch (e) {
        console.error("order rollup error", e);
      }
    }

    return Response.json(
      { ok: true, itemId, subStatus, status: rolledStatus, rollup },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

/**
 * Recompute summary booleans on the standard Order from ALL of its child items
 * of this station's Type. Each cfg.orderRollup entry's field is set true iff
 * every sibling item is at `atOrAfter` (by pipeline position) or later.
 * Returns the written booleans, or null if the order couldn't be resolved.
 */
async function rollupOrder(env, cfg, itemId) {
  const v = apiVersion(env);
  const flow = cfg.subStatusFlow;
  const idxOf = (val) => {
    const i = flow.indexOf(val || flow[0]); // blank sub-status = the first stage
    return i < 0 ? 0 : i;
  };

  // 1. Resolve the standard Order Id for the item that just changed.
  const q1 =
    `SELECT Production_Method__r.Order__r.Id FROM Pre_Production_Item__c WHERE Id = '${itemId}'`;
  const r1 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(q1)}`);
  const d1 = await r1.json();
  const rec1 = d1 && d1.records && d1.records[0];
  const orderId =
    rec1 && rec1.Production_Method__r && rec1.Production_Method__r.Order__r &&
    rec1.Production_Method__r.Order__r.Id;
  if (!orderId) return null;

  // 2. Every item of this Type on that order (reflects the write we just made).
  const q2 =
    `SELECT ${cfg.subStatusField} FROM Pre_Production_Item__c ` +
    `WHERE Type__c = '${cfg.type}' AND Production_Method__r.Order__c = '${orderId}'`;
  const r2 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(q2)}`);
  const d2 = await r2.json();
  const items = (d2 && d2.records) || [];
  if (!items.length) return null;

  // 3. Compute each Order checkbox: true iff ALL siblings are at/after the stage.
  const orderPayload = {};
  for (const m of cfg.orderRollup) {
    const target = idxOf(m.atOrAfter);
    orderPayload[m.field] = items.every((it) => idxOf(it[cfg.subStatusField]) >= target);
  }

  // 4. Write the summary booleans onto the standard Order.
  const rp = await sfFetch(env, `/services/data/${v}/sobjects/Order/${orderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderPayload),
  });
  if (!rp.ok && rp.status !== 204) {
    let t = "";
    try { t = JSON.stringify(await rp.json()); } catch { /* empty */ }
    console.error("order rollup PATCH failed", rp.status, t);
    return null;
  }
  return orderPayload;
}
