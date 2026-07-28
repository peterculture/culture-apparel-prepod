/**
 * GET /api/orders/:id/zk-wizard-url?num=<Order Number>
 *
 * Builds the URL for Zenkraft's "New Shipment" wizard -- a Visualforce page
 * (package zkmulti) opened from the "Print Label" button on an order's
 * Shipments panel. The wizard is pre-filled with this Order via Salesforce's
 * classic "New record" override URL convention:
 *   ?CF<fieldId>=<display text>&CF<fieldId>_lkid=<related record id>
 * where <fieldId> is the literal metadata Id of the
 * zkmulti__MCShipment__c.Order__c lookup field (API name is stable across
 * orgs, but Salesforce regenerates the field's Id per org -- it does NOT
 * carry over via a change set/metadata deploy the way the API name does).
 *
 * Both org-specific pieces this URL used to hardcode are resolved here
 * instead, so this endpoint (and the button that calls it) keep working
 * unmodified no matter which environment is currently active (see _sf.js's
 * getActiveSfEnv/admin/sf-env.js -- the whole point of that switcher is that
 * nothing downstream, including this file, needs to change when it flips):
 *   1. The wizard's own Visualforce domain, derived from the live
 *      instance_url returned with the active environment's access token
 *      (see _sf.js) -- not hardcoded to a specific sandbox name.
 *   2. The Order__c lookup field's Id, read via getZkOrderFieldId() (checks
 *      SF_ZK_ORDER_FIELD_ID_<ENV> first, falls back to the unsuffixed
 *      SF_ZK_ORDER_FIELD_ID) rather than baked into the code, since that
 *      value is genuinely different per org and has to be looked up by hand
 *      once per org -- see _sf.js's header comment for where to find it.
 */
import { getSalesforceToken, getZkOrderFieldId, jsonError } from "../../_sf.js";

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

// dev2's instance host looks like "cultureapparel--dev2.sandbox.my.salesforce.com"
// and its zkmulti Visualforce host is "cultureapparel--dev2--zkmulti.sandbox.vf.force.com" --
// same pattern for any sandbox. A non-sandbox org (production/dev/scratch) drops
// the ".sandbox" segment on both sides.
function deriveZkWizardBase(instanceUrl) {
  let host;
  try {
    host = new URL(instanceUrl).host;
  } catch {
    return null;
  }
  let m = host.match(/^(.+)\.sandbox\.my\.salesforce\.com$/);
  if (m) return `https://${m[1]}--zkmulti.sandbox.vf.force.com`;
  m = host.match(/^(.+)\.my\.salesforce\.com$/);
  if (m) return `https://${m[1]}--zkmulti.vf.force.com`;
  return null;
}

export async function onRequestGet({ params, request, env }) {
  try {
    const orderId = params && params.id;
    if (!SF_ID.test(orderId)) return jsonError("invalid_id", 400);

    const fieldId = await getZkOrderFieldId(env);
    if (!fieldId) {
      console.error("zk-wizard-url: no SF_ZK_ORDER_FIELD_ID configured for the active environment");
      return jsonError("zk_field_id_not_configured", 500);
    }

    const num = (new URL(request.url).searchParams.get("num") || "").slice(0, 80);

    const token = await getSalesforceToken(env);
    const base = deriveZkWizardBase(token.instance_url);
    if (!base) {
      console.error("zk-wizard-url: could not derive VF domain from", token.instance_url);
      return jsonError("zk_domain_unresolved", 500);
    }

    // Classic prefill hack expects the 15-char case-sensitive Id for the
    // "_lkid" param (matches the original hardcoded implementation this
    // replaces -- kept identical rather than switching to the 18-char Id on
    // a hunch).
    const id15 = orderId.slice(0, 15);
    const F = `CF${fieldId}`;
    const qs = new URLSearchParams({
      [F]: num,
      [`${F}_lkid`]: id15,
      navigationLocation: "RELATED_LIST",
      lexiSObjectName: "zkmulti__MCShipment__c",
      lexiActionName: "new",
      "sfdc.override": "1",
    });

    return Response.json(
      { url: `${base}/apex/Wizard?${qs.toString()}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
