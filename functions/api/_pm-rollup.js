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
