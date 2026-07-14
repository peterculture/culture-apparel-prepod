/**
 * DELETE /api/packaging/<id>
 *
 * Removes one Packaging__c record -- lets a worker undo a mis-logged
 * package entry (wrong type/quantity typed in). Salesforce returns 204 No
 * Content on a successful delete.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export async function onRequestDelete({ env, params }) {
  try {
    const id = params && params.id;
    if (!SF_ID.test(id)) return jsonError("invalid_id", 400);

    const path = `/services/data/${apiVersion(env)}/sobjects/Packaging__c/${encodeURIComponent(id)}`;
    const resp = await sfFetch(env, path, { method: "DELETE" });

    if (resp.status === 204) {
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const detail = await resp.text();
    console.error("Packaging delete failed", resp.status, detail);
    return jsonError("delete_failed", resp.status);
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
