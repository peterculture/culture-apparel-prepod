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
import { runQuery, sfFetch, apiVersion } from "./_sf.js";

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

  // Always tiny (one order's own sibling methods), but runQuery is used
  // everywhere a query runs now for consistency -- see _sf.js.
  const { ok, records } = await runQuery(env, soql);
  if (!ok) return null;
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
    // 1. Resolve the parent Order from this one method. (A query by Id
    // always matches at most one record, so pagination never applies here --
    // runQuery is used anyway purely for a consistent call shape.)
    const q1 = `SELECT Order__c FROM ${PM_OBJECT} WHERE Id = '${methodId}'`;
    const { records: r1records } = await runQuery(env, q1);
    const orderId = r1records[0] && r1records[0].Order__c;
    if (!orderId) return null;

    // 2. Pull every non-cancelled sibling's checklist fields + type in one go.
    const soql =
      `SELECT Type__c, ${CHECKLIST_FIELDS.join(", ")} FROM ${PM_OBJECT} ` +
      `WHERE Order__c = '${orderId}' AND Status__c != 'Cancelled'`;
    const { ok: r2ok, records: methods } = await runQuery(env, soql);
    if (!r2ok || !methods.length) return null;

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

/**
 * Shared helper: mirror the SUM of each Production_Method__c's own timer
 * fields (Print_Setup_Timer__c, Production_Timer__c) back onto the
 * legacy Order-level fields of the same name.
 *
 * WHY THIS EXISTS (2026-08-05): the per-method timer migration gave every
 * Production_Method__c its own Print_Setup_Timer__c/Production_Timer__c so
 * sibling methods on one order (e.g. a screen print method + a heat press
 * method) time independently. index.html's drawer already shows a correct
 * "combined order total" for these -- but that total is computed IN MEMORY,
 * on every GET, by orders/index.js and production-orders/index.js purely for
 * display. Nothing ever wrote that sum back to the Order record itself, so
 * anyone checking Order.Print_Setup_Timer__c/Production_Timer__c directly in
 * Salesforce (a report, a standard page layout, a flow) saw a stale or
 * zeroed value even though the app's own UI looked correct. This closes that
 * gap the same way rollupChecklistToOrder above keeps the Order's checklist
 * copies honest: recompute from the (non-cancelled) sibling methods, write
 * to Order, best-effort.
 *
 * @param {string} methodId - Id of the Production_Method__c whose own timer
 *   field(s) were just written.
 * @returns {Promise<Object|null>} the Order fields that were written, or null.
 */
const TIMER_FIELDS = ["Print_Setup_Timer__c", "Production_Timer__c"];

export async function rollupTimerToOrder(env, methodId) {
  if (!methodId) return null;
  const v = apiVersion(env);
  try {
    // 1. Resolve the parent Order from this one method.
    const q1 = `SELECT Order__c FROM ${PM_OBJECT} WHERE Id = '${methodId}'`;
    const { records: r1records } = await runQuery(env, q1);
    const orderId = r1records[0] && r1records[0].Order__c;
    if (!orderId) return null;

    // 2. Pull every non-cancelled sibling's own timer fields.
    const soql =
      `SELECT ${TIMER_FIELDS.join(", ")} FROM ${PM_OBJECT} ` +
      `WHERE Order__c = '${orderId}' AND Status__c != 'Cancelled'`;
    const { ok, records: methods } = await runQuery(env, soql);
    if (!ok) return null;

    // 3. SUM each field across every sibling (methods with no time logged
    // yet just contribute 0 -- same shape as the client-side sum in
    // orders/index.js / production-orders/index.js).
    const payload = {};
    for (const field of TIMER_FIELDS) {
      payload[field] = methods.reduce((sum, m) => sum + (Number(m[field]) || 0), 0);
    }

    const orderPath = `/services/data/${v}/sobjects/Order/${orderId}`;
    const orderResp = await sfFetch(env, orderPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (orderResp.status !== 204) {
      let t = "";
      try { t = JSON.stringify(await orderResp.json()); } catch { /* empty */ }
      console.error("rollupTimerToOrder: order PATCH failed", orderResp.status, t);
      return null;
    }
    return payload;
  } catch (e) {
    console.error("rollupTimerToOrder failed", methodId, e);
    return null;
  }
}

/**
 * Shared helper: recompute an Order's TotalQtyMisprints__c as the true SUM
 * of OrderItem.Quantity across every reprint child-order linked back to it
 * (Order.Original_Production_Order__c = this order), instead of trusting
 * whatever value the field currently holds.
 *
 * WHY THIS EXISTS (2026-08-05): orders/[id]/reprint.js used to PATCH this
 * field additively (priorTotal + thisRun'sQty) so that a second, later
 * reprint against the same order wouldn't erase an earlier one's count. But
 * TotalQtyMisprints__c is ALSO directly writable from the order drawer's
 * misprint stepper (setMis() in index.html), which does a plain overwrite --
 * so flagging misprints there first and then formalizing those SAME units
 * into a reprint double-counted them (stepper's 2 + reprint's 2 = 4 instead
 * of 2). Recomputing from the actual reprint child-orders' line items sidesteps
 * that entirely: it no longer matters what the field said before or how it
 * got there, and each genuine reprint still contributes exactly once no
 * matter how many separate reprints an order has had over time.
 *
 * @param {string} orderId - the ORIGINAL Order (not a reprint child order).
 * @returns {Promise<number|null>} the TotalQtyMisprints__c value that was written, or null.
 */
export async function rollupMisprintsToOrder(env, orderId) {
  if (!orderId) return null;
  const v = apiVersion(env);
  try {
    // 1. Find every reprint child-order ever created off this one.
    const childSoql = `SELECT Id FROM Order WHERE Original_Production_Order__c = '${orderId}'`;
    const { ok: childOk, records: children } = await runQuery(env, childSoql);
    if (!childOk) return null;

    let total = 0;
    if (children.length) {
      // 2. Sum every reprint line's Quantity across all of them in one query.
      const quotedIds = children.map((c) => `'${c.Id}'`).join(",");
      const itemSoql = `SELECT Quantity FROM OrderItem WHERE OrderId IN (${quotedIds})`;
      const { ok: itemOk, records: items } = await runQuery(env, itemSoql);
      if (!itemOk) return null;
      total = items.reduce((sum, i) => sum + (Number(i.Quantity) || 0), 0);
    }

    const orderPath = `/services/data/${v}/sobjects/Order/${orderId}`;
    const orderResp = await sfFetch(env, orderPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ TotalQtyMisprints__c: total }),
    });
    if (orderResp.status !== 204) {
      let t = "";
      try { t = JSON.stringify(await orderResp.json()); } catch { /* empty */ }
      console.error("rollupMisprintsToOrder: order PATCH failed", orderResp.status, t);
      return null;
    }
    return total;
  } catch (e) {
    console.error("rollupMisprintsToOrder failed", orderId, e);
    return null;
  }
}
