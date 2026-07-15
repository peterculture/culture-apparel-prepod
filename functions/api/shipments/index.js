/**
 * GET  /api/shipments?orderId=<Order Id>
 *   Lists shipments logged against one order. Backed by the Zenkraft
 *   Multi-Carrier Shipping managed package's `zkmulti__MCShipment__c`
 *   object -- the same object behind the "Shipments" related list on the
 *   Order page in Salesforce. Real label purchase happens through
 *   Zenkraft's own Shipment Wizard (calls FedEx/UPS/USPS APIs and spends
 *   real money) -- this endpoint does NOT do that. It only logs the
 *   reference info (carrier, service, tracking number, weight) for a
 *   shipment *after* the real label has already been bought, either
 *   through the Zenkraft wizard (linked from the app) or elsewhere.
 *
 *   Weight lives on a child `zkmulti__MCPackage__c` record
 *   (`zkmulti__Shipment__c` lookup back to the shipment) in Zenkraft's
 *   data model, not on the shipment itself, so this handler runs a second
 *   query and merges each shipment's package weight in before returning.
 *
 * POST /api/shipments
 *   Logs one shipment: creates a zkmulti__MCShipment__c row, then (if a
 *   weight was given) a linked zkmulti__MCPackage__c row underneath it.
 *   Body: { orderId, Carrier, ServiceType, TrackingNumber, Weight }
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

const SHIPMENT_FIELDS = [
  "Id",
  "Name",
  "zkmulti__Carrier__c",
  "zkmulti__Service_Type_Name__c",
  "zkmulti__Tracking_Number__c",
  "zkmulti__Ship_Date__c",
  "CreatedDate",
];

export async function onRequestGet({ env, request }) {
  try {
    const orderId = new URL(request.url).searchParams.get("orderId") || "";
    if (!SF_ID.test(orderId)) return jsonError("invalid_order_id", 400);

    const soql =
      `SELECT ${SHIPMENT_FIELDS.join(", ")} FROM zkmulti__MCShipment__c ` +
      `WHERE Order__c = '${orderId}' ORDER BY CreatedDate DESC`;
    const path = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;

    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Shipment query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }

    const shipments = data.records || [];
    if (shipments.length) {
      const ids = shipments.map((s) => `'${s.Id}'`).join(",");
      const pkgSoql =
        `SELECT zkmulti__Shipment__c, zkmulti__Weight__c, zkmulti__Weight_Units__c ` +
        `FROM zkmulti__MCPackage__c WHERE zkmulti__Shipment__c IN (${ids})`;
      const pkgPath = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(pkgSoql)}`;
      const pkgResp = await sfFetch(env, pkgPath);
      const pkgData = await pkgResp.json();
      if (pkgResp.ok) {
        const byShipment = new Map();
        (pkgData.records || []).forEach((p) => {
          if (!byShipment.has(p.zkmulti__Shipment__c)) byShipment.set(p.zkmulti__Shipment__c, p);
        });
        shipments.forEach((s) => {
          const pkg = byShipment.get(s.Id);
          s.Weight = pkg ? pkg.zkmulti__Weight__c : null;
          s.WeightUnits = pkg ? pkg.zkmulti__Weight_Units__c : null;
        });
      }
    }

    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    if (!body || typeof body !== "object") return jsonError("invalid_body", 400);

    const orderId = body.orderId || "";
    if (!SF_ID.test(orderId)) return jsonError("invalid_order_id", 400);

    const carrier = (body.Carrier || "").toString().trim();
    const serviceType = (body.ServiceType || "").toString().trim();
    const trackingNumber = (body.TrackingNumber || "").toString().trim();
    if (!carrier) return jsonError("missing_carrier", 400);
    if (!trackingNumber) return jsonError("missing_tracking_number", 400);

    const shipPayload = {
      Order__c: orderId,
      zkmulti__Carrier__c: carrier,
      zkmulti__Service_Type_Name__c: serviceType || null,
      zkmulti__Tracking_Number__c: trackingNumber,
      zkmulti__Ship_Date__c: new Date().toISOString().slice(0, 10),
    };

    const shipPath = `/services/data/${apiVersion(env)}/sobjects/zkmulti__MCShipment__c`;
    const shipResp = await sfFetch(env, shipPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shipPayload),
    });
    const shipData = await shipResp.json().catch(() => null);
    if (!shipResp.ok || !shipData || shipData.success === false) {
      console.error("Shipment create failed", shipResp.status, JSON.stringify(shipData));
      return jsonError("create_failed", shipResp.status || 502);
    }
    const shipmentId = shipData.id;

    const weight = Number(body.Weight);
    if (Number.isFinite(weight) && weight > 0) {
      const pkgPath = `/services/data/${apiVersion(env)}/sobjects/zkmulti__MCPackage__c`;
      const pkgResp = await sfFetch(env, pkgPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zkmulti__Shipment__c: shipmentId,
          zkmulti__Weight__c: weight,
          zkmulti__Weight_Units__c: "lbs",
        }),
      });
      if (!pkgResp.ok) {
        const detail = await pkgResp.text();
        // The shipment itself was created fine -- log the package failure but
        // don't fail the whole request over it, the weight just won't show.
        console.error("Package create failed", pkgResp.status, detail);
      }
    }

    return Response.json(
      { ok: true, id: shipmentId },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
