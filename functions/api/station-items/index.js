/**
 * GET /api/station-items
 *
 * Returns the schedule for the CALLER'S station: every Pre-Production Item of
 * that station's Type__c that isn't done yet, each with its Order details for
 * the worker to read. Read-only: one SELECT, nothing else.
 *
 * The station is NOT a client parameter -- it comes from the verified, signed
 * station token (cookie). A worker holding an ink token can only ever pull the
 * ink schedule; the browser has no way to request another station's rows. That
 * is the "restricted data never reaches the browser" guarantee.
 *
 * Type__c and the field list come entirely from server-side STATION_CONFIG, so
 * unlike a client param there's nothing here to inject into.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { verifyStationToken, STATION_CONFIG } from "../_station.js";

export async function onRequestGet({ env, request }) {
  try {
    const station = await verifyStationToken(env, request);
    if (!station) return jsonError("unauthorized", 401);

    const cfg = STATION_CONFIG[station];
    if (!cfg) return jsonError("station_not_configured", 400);

    const soql =
      `SELECT ${cfg.selectFields.join(", ")} ` +
      `FROM Pre_Production_Item__c ` +
      `WHERE Type__c = '${cfg.type}' AND Status__c != '${cfg.doneStatus}' ` +
      `ORDER BY ${cfg.orderBy}`;

    const path =
      `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;
    const resp = await sfFetch(env, path);
    const data = await resp.json();

    if (!resp.ok) {
      console.error("station-items query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
