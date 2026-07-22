/**
 * Shared helper: after a Production_Method__c's Status__c changes, roll the
 * parent Order's Order_Substatus__c up/down to match whichever sibling
 * method is LEAST advanced. Several screens still read Order_Substatus__c
 * as the order's single stage (the pre-production inbox filter, KPIs on the
 * floor board, order-sheet.html) -- now that stage is tracked per-method,
 * this keeps that order-level field an honest summary instead of going
 * stale the first time a method is patched independently.
 *
 * Cancelled methods are excluded from the calculation (a cancelled method
 * shouldn't hold the rest of the order back). On Hold counts as the lowest
 * rank, same as Pre-Production, since Order_Substatus__c has no "On Hold"
 * value of its own (see ALLOWED_SUBSTATUSES in orders/[id].js).
 *
 * Best-effort by design: callers should await this but not fail their own
 * write if it throws or returns null.
 */
import { sfFetch, apiVersion } from "./_sf.js";

const PM_OBJECT = "Production_Method__c";

// Production_Method__c.Status__c rank, lowest = least advanced. Keep in sync
// with ALLOWED_STATUSES in production-methods/index.js and [id].js.
const PM_RANK = {
  "Pre-Production": 0,
  "On Hold": 0,
  "Ready for Print": 1,
  "In Production": 2,
  "Post-Production": 3,
  "Completed": 4,
};

// rank -> Order.Order_Substatus__c stored value. NOTE: the Order field's
// "In Production" label has an actual stored value of "Production" (label
// changed in Salesforce without updating the underlying value -- see the
// long comment in orders/[id].js). Production_Method__c.Status__c has no
// such quirk; its "In Production" value really is "In Production".
const RANK_TO_ORDER_SUBSTATUS = {
  0: "Pre-Production",
  1: "Ready for Print",
  2: "Production",
  3: "Post-Production",
  4: "Completed",
};

/**
 * @param {string} orderId - already-validated Salesforce Id of the parent Order.
 * @returns {Promise<string|null>} the Order_Substatus__c value that was written, or null.
 */
export async function rollupOrderSubstatus(env, orderId) {
  if (!orderId) return null;
  const v = apiVersion(env);
  const soql =
    `SELECT Status__c FROM ${PM_OBJECT} ` +
    `WHERE Order__c = '${orderId}' AND Status__c != 'Cancelled'`;
  const path = `/services/data/${v}/query/?q=${encodeURIComponent(soql)}`;

  const resp = await sfFetch(env, path);
  if (!resp.ok) return null;
  const data = await resp.json();
  const records = Array.isArray(data.records) ? data.records : [];
  if (!records.length) return null;

  let minRank = null;
  for (const r of records) {
    const rank = PM_RANK[r.Status__c];
    if (rank == null) continue;
    if (minRank == null || rank < minRank) minRank = rank;
  }
  if (minRank == null) return null;

  const substatus = RANK_TO_ORDER_SUBSTATUS[minRank];
  if (!substatus) return null;

  const orderPath = `/services/data/${v}/sobjects/Order/${orderId}`;
  const orderResp = await sfFetch(env, orderPath, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Order_Substatus__c: substatus }),
  });
  return orderResp.status === 204 ? substatus : null;
}

/**
 * Shared helper: mirror each Production_Method__c's own "Pre-Production
 * Checklist" booleans back onto the legacy Order-level fields of the same
 * name (Films_Printed__c, Screens_Completed__c, Mix_Inks__c, Digitize_File__c,
 * Thread_Color_Materials__c, Transfers_Received__c, Transfers_Ready__c --
 * still writable via orders/[id].js's ALLOWED_FIELDS for any caller reading
 * the Order directly, e.g. a standard Salesforce page layout or report).
 *
 * WHY THIS EXISTS (2026-07-22): the 2026-07-21 per-method migration moved
 * these checklist booleans onto Production_Method__c and, correctly, stopped
 * treating the Order copy as the source of truth for the web boards. But the
 * Order fields are the SAME Salesforce fields they always were -- nothing
 * ever taught them to follow their new per-method counterparts, so an item
 * completing (or a manager checking the box on a method card) now updates
 * Production_Method__c and leaves the Order-level checkbox stuck at whatever
 * it last was. This closes that gap the same way rollupOrderSubstatus above
 * keeps Order_Substatus__c honest: recompute from the methods, write to Order,
 * best-effort.
 *
 * ONE ORDER FIELD PER METHOD TYPE: an order can carry siblings of different
 * types (Screen Print + Heat Press), and each checklist field only means
 * something for ONE type (Screens_Completed__c is Screen-Print-only, for
 * example) -- every Production_Method__c carries all 7 fields regardless of
 * its own type (see CHECKLIST_FIELDS in production-methods/[id].js), but the
 * UI only ever shows/toggles the 2-3 relevant to that method's type, so an
 * unrelated sibling's always-false default must NOT drag the Order field
 * down. Scoped per field to just the sibling methods of its matching type;
 * the Order value is TRUE only when EVERY one of those siblings is TRUE (AND,
 * not OR) -- the same "least advanced wins" spirit as the substatus rollup,
 * just applied to booleans. A field with no matching-type sibling on this
 * order (e.g. Screens_Completed__c on an order with only a Heat Press method)
 * has nothing to roll up and is left alone rather than forced to false.
 * Cancelled methods are excluded, same as the substatus rollup above.
 */
const CHECKLIST_FIELD_TYPE = {
  Films_Printed__c: "Screen Print",
  Screens_Completed__c: "Screen Print",
  Mix_Inks__c: "Screen Print",
  Digitize_File__c: "Embroidery",
  Thread_Color_Materials__c: "Embroidery",
  Transfers_Received__c: "Heat Press",
  Transfers_Ready__c: "Heat Press",
};
const CHECKLIST_FIELDS = Object.keys(CHECKLIST_FIELD_TYPE);

/**
 * @param {string} methodId - Id of the Production_Method__c that was just
 *   written (either by a manual checklist PATCH or the item-driven cascade).
 * @returns {Promise<Object|null>} the Order fields that were written, or null.
 */
export async function rollupChecklistToOrder(env, methodId) {
  if (!methodId) return null;
  const v = apiVersion(env);
  try {
    // 1. Resolve the parent Order from this one method.
    const q1 = `SELECT Order__c FROM ${PM_OBJECT} WHERE Id = '${methodId}'`;
    const r1 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(q1)}`);
    const d1 = await r1.json();
    const orderId = d1 && d1.records && d1.records[0] && d1.records[0].Order__c;
    if (!orderId) return null;

    // 2. Pull every non-cancelled sibling's checklist fields + type in one go.
    const soql =
      `SELECT Type__c, ${CHECKLIST_FIELDS.join(", ")} FROM ${PM_OBJECT} ` +
      `WHERE Order__c = '${orderId}' AND Status__c != 'Cancelled'`;
    const r2 = await sfFetch(env, `/services/data/${v}/query/?q=${encodeURIComponent(soql)}`);
    const d2 = await r2.json();
    const methods = Array.isArray(d2.records) ? d2.records : [];
    if (!methods.length) return null;

    // 3. AND each field across just its matching-type siblings.
    const payload = {};
    for (const field of CHECKLIST_FIELDS) {
      const type = CHECKLIST_FIELD_TYPE[field];
      const relevant = methods.filter((m) => m.Type__c === type);
      if (!relevant.length) continue; // nothing of this type on the order -- leave Order field as-is
      payload[field] = relevant.every((m) => !!m[field]);
    }
    if (!Object.keys(payload).length) return null;

    const orderPath = `/services/data/${v}/sobjects/Order/${orderId}`;
    const orderResp = await sfFetch(env, orderPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (orderResp.status !== 204) {
      let t = "";
      try { t = JSON.stringify(await orderResp.json()); } catch { /* empty */ }
      console.error("rollupChecklistToOrder: order PATCH failed", orderResp.status, t);
      return null;
    }
    return payload;
  } catch (e) {
    console.error("rollupChecklistToOrder failed", methodId, e);
    return null;
  }
}
