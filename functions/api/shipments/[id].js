/**
 * DELETE /api/shipments/<id>
 *
 * Removes one logged zkmulti__MCShipment__c record -- lets a worker undo a
 * mis-logged shipment entry. Deletes any child zkmulti__MCPackage__c
 * row(s) first (own query, since we don't know if that lookup is set up
 * to cascade-delete in this org) then the shipment itself.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export async function onRequestDelete({ env, params }) {
  try {
    const id = params && params.id;
    if (!SF_ID.test(id)) return jsonError("invalid_id", 400);

    const pkgSoql = `SELECT Id FROM zkmulti__MCPackage__c WHERE zkmulti__Shipment__c = '${id}'`;
    const pkgQueryPath = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(pkgSoql)}`;
    const pkgQueryResp = await sfFetch(env, pkgQueryPath);
    if (pkgQueryResp.ok) {
      const pkgData = await pkgQueryResp.json();
      for (const pkg of pkgData.records || []) {
        const delPath = `/services/data/${apiVersion(env)}/sobjects/zkmulti__MCPackage__c/${pkg.Id}`;
        await sfFetch(env, delPath, { method: "DELETE" });
      }
    }

    const path = `/services/data/${apiVersion(env)}/sobjects/zkmulti__MCShipment__c/${encodeURIComponent(id)}`;
    const resp = await sfFetch(env, path, { method: "DELETE" });

    if (resp.status === 204) {
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const detail = await resp.text();
    console.error("Shipment delete failed", resp.status, detail);
    return jsonError("delete_failed", resp.status);
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
