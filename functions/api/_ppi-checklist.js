/**
 * Cascading sync between each Production_Method__c's own "Pre-Production
 * Checklist" booleans (Screens_Completed__c, Mix_Inks__c,
 * Transfers_Received__c, Transfers_Ready__c, Digitize_File__c,
 * Thread_Color_Materials__c -- rendered as checkboxes in pre-production.html,
 * one set PER METHOD since the 2026-07-21 per-method migration) and the
 * individual Pre_Production_Item__c records that back each one (Type__c =
 * Screen / Ink / Transfer / Digitization / Thread), scoped by each item's own
 * Production_Method__c lookup.
 *
 * TWO DIRECTIONS:
 *   1. FORWARD (checkbox -> items): when a worker checks one of these boxes on
 *      a method, every sibling item of the matching type ON THAT SAME METHOD
 *      is pushed to its "ready" sub-status (and Status__c). Called from
 *      production-methods/[id].js after a successful checklist-field PATCH.
 *   2. REVERSE (items -> checkbox): when an individual item is edited (from
 *      the pre-production worker board OR a station tablet) and, as a result,
 *      EVERY sibling item of that type on the SAME PARENT METHOD is now
 *      "ready", the matching Production_Method__c checkbox(es) are set true
 *      automatically. Recomputed both ways on every write, so an item moving
 *      backward unchecks the box again -- same behavior the Transfer station
 *      rollup already has. Called from pre-production-items/[id].js after a
 *      successful item PATCH.
 *
 * WHY PRODUCTION_METHOD__C, NOT ORDER (2026-07-22): this used to be scoped by
 * Production_Method__r.Order__c (every item across every method on the whole
 * order) and wrote its results onto Order -- built against the OLD shared,
 * order-level checklist, and never migrated when the checklist fields moved
 * onto Production_Method__c itself. That orphaned mismatch was the root cause
 * of checked boxes no longer moving items to "ready": the write path
 * (production-methods/[id].js) had no cascade call at all, and the cascade
 * logic that DID exist was still wired only to the old Order PATCH path and
 * scoped/targeted the wrong object. Scoping by the item's own
 * Production_Method__c lookup keeps two Screen Print methods on the same
 * order (e.g. front + back) from cross-triggering each other's screens.
 *
 * Screen / Ink / Transfer reuse the exact sub-status pipelines already
 * verified in _station.js's STATION_CONFIG (single source of truth -- no
 * duplicated/could-drift copies here). Digitization / Thread (embroidery)
 * have no dedicated sub-status field on Pre_Production_Item__c, only the
 * generic Status__c, so their "ready" test is just Status__c === 'Ready'.
 */
import { sfFetch, apiVersion } from "./_sf.js";
import { STATION_CONFIG } from "./_station.js";
import { rollupChecklistToOrder } from "./_pm-rollup.js";

// Embroidery item types -- no tablet station, no sub-status pipeline, just
// the generic Status__c (Not Started / In Progress / Ready).
const EXTRA_TYPES = {
  Digitization: { checklistField: "Digitize_File__c" },
  Thread: { checklistField: "Thread_Color_Materials__c" },
};

function idxOf(flow, val) {
  const i = flow.indexOf(val || flow[0]); // blank sub-status = the pipeline's start
  return i < 0 ? 0 : i;
}

// checklist field -> { type, subStatusField, readySubStatus, readyStatus }
// Built from STATION_CONFIG.orderRollup so it can't drift from the tablet
// station config, plus the two embroidery-only entries.
function buildForwardRule(field) {
  for (const key of Object.keys(STATION_CONFIG)) {
    const cfg = STATION_CONFIG[key];
    if (!cfg.orderRollup) continue;
    const hit = cfg.orderRollup.find((r) => r.field === field);
    if (hit) {
      return {
        type: cfg.type,
        subStatusField: cfg.subStatusField,
        readySubStatus: hit.atOrAfter,
        readyStatus: cfg.statusMap ? cfg.statusMap[hit.atOrAfter] : null,
      };
    }
  }
  const extraType = Object.keys(EXTRA_TYPES).find((t) => EXTRA_TYPES[t].checklistField === field);
  if (extraType) return { type: extraType, subStatusField: null, readySubStatus: null, readyStatus: "Ready" };
  return null; // e.g. Films_Printed__c -- no linked item type
}

/**
 * Forward cascade. `checkedFields` is the list of checklist boolean fields
 * that were just set TRUE in this Production_Method__c PATCH (unchecking
 * never cascades down -- only the explicit "mark this done" action does).
 * Best-effort: logs and continues on any per-field failure.
 */
export async function cascadeChecklistToItems(env, methodId, checkedFields) {
  const v = apiVersion(env);
  for (const field of checkedFields) {
    const rule = buildForwardRule(field);
    if (!rule) continue;
    try {
      const soql =
        `SELECT Id FROM Pre_Production_Item__c ` +
        `WHERE Type__c = '${rule.type}' AND Production_Method__c = '${methodId}'`;
      const r = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(soql)}`);
      const d = await r.json();
      const items = (d && d.records) || [];
      if (!items.length) continue;

      const payload = {};
      if (rule.subStatusField) payload[rule.subStatusField] = rule.readySubStatus;
      if (rule.readyStatus) payload.Status__c = rule.readyStatus;
      if (!Object.keys(payload).length) continue;

      await Promise.all(
        items.map((it) =>
          sfFetch(env, `/services/data/${v}/sobjects/Pre_Production_Item__c/${it.Id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).catch((e) => console.error("cascadeChecklistToItems: item PATCH failed", it.Id, e)),
        ),
      );
    } catch (e) {
      console.error("cascadeChecklistToItems failed for", field, e);
    }
  }
}

/**
 * Reverse cascade. Give it the Id of a Pre_Production_Item__c that was just
 * updated; it resolves the item's Type__c + its own parent Production_Method__c
 * (a direct lookup on the item -- no Order traversal needed), recomputes every
 * checklist field tied to that type across ALL sibling items ON THAT SAME
 * METHOD, and writes the result onto that Production_Method__c. Returns the
 * written payload, or null if nothing could be resolved (item not found, type
 * not tracked, etc).
 */
export async function rollupItemToMethod(env, itemId) {
  const v = apiVersion(env);
  try {
    const q1 = `SELECT Type__c, Production_Method__c FROM Pre_Production_Item__c WHERE Id = '${itemId}'`;
    const r1 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(q1)}`);
    const d1 = await r1.json();
    const rec1 = d1 && d1.records && d1.records[0];
    const type = rec1 && rec1.Type__c;
    const methodId = rec1 && rec1.Production_Method__c;
    if (!type || !methodId) return null;

    // Ink / Screen / Transfer: driven by their verified sub-status pipeline.
    const stationKey = Object.keys(STATION_CONFIG).find(
      (k) => STATION_CONFIG[k].type === type && STATION_CONFIG[k].orderRollup,
    );
    if (stationKey) {
      const cfg = STATION_CONFIG[stationKey];
      const flow = cfg.subStatusFlow;
      const q2 =
        `SELECT ${cfg.subStatusField} FROM Pre_Production_Item__c ` +
        `WHERE Type__c = '${type}' AND Production_Method__c = '${methodId}'`;
      const r2 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(q2)}`);
      const d2 = await r2.json();
      const items = (d2 && d2.records) || [];
      if (!items.length) return null;

      const methodPayload = {};
      for (const m of cfg.orderRollup) {
        const target = idxOf(flow, m.atOrAfter);
        methodPayload[m.field] = items.every((it) => idxOf(flow, it[cfg.subStatusField]) >= target);
      }
      return writeMethodPayload(env, methodId, methodPayload);
    }

    // Digitization / Thread (embroidery): no sub-status pipeline, just Status__c.
    const extra = EXTRA_TYPES[type];
    if (extra) {
      const q2 =
        `SELECT Status__c FROM Pre_Production_Item__c ` +
        `WHERE Type__c = '${type}' AND Production_Method__c = '${methodId}'`;
      const r2 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(q2)}`);
      const d2 = await r2.json();
      const items = (d2 && d2.records) || [];
      if (!items.length) return null;

      const allReady = items.every((it) => it.Status__c === "Ready");
      return writeMethodPayload(env, methodId, { [extra.checklistField]: allReady });
    }

    return null;
  } catch (e) {
    console.error("rollupItemToMethod failed", itemId, e);
    return null;
  }
}

async function writeMethodPayload(env, methodId, payload) {
  const v = apiVersion(env);
  const rp = await sfFetch(env, `/services/data/${v}/sobjects/Production_Method__c/${methodId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!rp.ok && rp.status !== 204) {
    let t = "";
    try { t = JSON.stringify(await rp.json()); } catch { /* empty */ }
    console.error("rollupItemToMethod: method PATCH failed", rp.status, t);
    return null;
  }
  // Mirror onto the legacy Order-level checklist fields too (see
  // _pm-rollup.js's rollupChecklistToOrder) -- best-effort, never undoes the
  // Production_Method__c write above if it fails.
  await rollupChecklistToOrder(env, methodId).catch((e) =>
    console.error("rollupItemToMethod: order mirror failed", e),
  );
  return payload;
}
