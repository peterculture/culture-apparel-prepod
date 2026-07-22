/**
 * POST /api/update-item-status
 * Body: { "station": "<name>", "itemId": "<15/18-char SF Id>", "subStatus": "<value>", "by": "<worker name>" }
 *
 * Advances one Pre-Production Item's sub-status for the given station, and
 * sets the rolled-up Status__c in the SAME write (derived server-side from
 * the station's statusMap -- see _station.js).
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
import { rollupItemToMethod } from "../_ppi-checklist.js";

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

    // Status__c: every station now derives + writes it here from the
    // sub-status (cfg.statusMap) rather than trusting an external Salesforce
    // flow to roll it up -- see _station.js for why. cfg.statusViaFlow is kept
    // only in case a station is ever added that genuinely has a confirmed flow.
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

    // Roll-up onto this item's own parent Production_Method__c checklist
    // field (e.g. Screens_Completed__c). Best-effort: the item update already
    // succeeded, so a roll-up failure is logged, not fatal.
    //
    // FIXED 2026-07-22: this used to call a LOCAL rollupOrder() below --  a
    // second, never-updated copy of the same cascade logic that lived in
    // ../_ppi-checklist.js. That copy still scoped by
    // Production_Method__r.Order__c (every sibling method on the whole
    // order) and wrote the result onto the standard Order, from before the
    // 2026-07-21 per-method checklist migration. _ppi-checklist.js's own
    // copy was already fixed to scope by Production_Method__c and write to
    // Production_Method__c (see rollupItemToMethod) -- but this station
    // endpoint kept calling its own stale local copy instead, so items
    // advanced from a station TABLET (as opposed to the pre-production
    // manager board, which already called the fixed helper) never flipped
    // the checkbox. Now both write paths share the one fixed helper.
    let rollup = null;
    if (cfg.orderRollup) {
      rollup = await rollupItemToMethod(env, itemId).catch((e) => {
        console.error("item rollup error", e);
        return null;
      });
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
