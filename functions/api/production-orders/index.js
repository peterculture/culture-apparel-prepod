/**
 * GET /api/production-orders
 *
 * Powers the Production Dashboard (index.html). Production_Method__c --
 * NOT Order -- is the root of this query. Every row already IS a board
 * card: it carries its own Status__c (which decides its column, see
 * stageOfMethod() in ca-api.js) and every order-level field a card needs,
 * pulled through the Order__r relationship. Rows are grouped into an
 * order-shaped payload afterward purely for DISPLAY -- Order is a grouping
 * label here, not a gate.
 *
 * WHY THIS SHAPE (2026-07-22): a per-method status should be the only
 * thing that decides whether a card shows up here and which column it
 * lands in. Earlier versions of this endpoint queried Order first and
 * filtered by Order.Order_Substatus__c -- a field that's rolled up to
 * whichever sibling method is LEAST advanced (see _pm-rollup.js) -- or by
 * a side-query checking for a qualifying method, with a fallback back to
 * that same order-level filter on error. Both approaches kept Order as the
 * source of truth for visibility, so a multi-method order (e.g. a Screen
 * Print method still in Pre-Production alongside a Heat Press method
 * already in Post-Production) could vanish from this whole dashboard --
 * or the "fixed" version could silently degrade back into that exact bug
 * the moment the side-query had a transient failure. Querying
 * Production_Method__c directly removes the order-level gate entirely:
 * each method's visibility depends only on itself, with no side-query and
 * nothing to fall back to.
 *
 * WHY A SEPARATE ENDPOINT FROM /api/orders: /api/orders filters on the
 * standard `Status` field (`WHERE Status = 'Pre-Production'`), which is
 * correct for the Pre-Production Dashboard but doesn't track production
 * work -- `Status` is a standard order-fulfillment field that advances on
 * its own (e.g. to "Enter Tracking") once shipping/tracking info is
 * entered, well before production work is actually done. Confirmed on
 * Order 00013456, 2026-07-14.
 */
import { sfFetch, apiVersion, jsonError } from "../_sf.js";
import { fetchMockupsByOpportunity } from "../_mockup.js";

// Production_Method__c.Status__c values shown on this board -- kept in
// sync with STAGE_KEY in ca-api.js (drives column placement) and PM_RANK
// in _pm-rollup.js. On Hold ranks the same as Pre-Production in both, so
// it's deliberately excluded here too: a method on hold shouldn't put its
// order on the production floor board.
const BOARD_STATUSES = [
  "Ready for Print",
  "In Production",
  "Post-Production",
  "Completed",
];

// Production_Method__c fields every card needs -- same set the old
// enrichment query fetched, just as the primary SELECT now.
const PM_FIELDS = [
  "Id",
  "Order__c",
  "Type__c",
  "Placement__c",
  "Placements__c",
  "Status__c",
  "Vendor__r.Name",
  "Films_Printed__c",
  "Screens_Completed__c",
  "Mix_Inks__c",
  "Digitize_File__c",
  "Thread_Color_Materials__c",
  "Transfers_Received__c",
  "Transfers_Ready__c",
];

// Order-level fields every card needs, reached through the Order__r
// relationship -- the same fields the old FIELDS list selected directly
// off Order, just re-pathed.
const ORDER_FIELDS = [
  "Order__r.Id",
  "Order__r.GOA_Order_Number__c",
  "Order__r.OpportunityId",
  "Order__r.Opportunity.SyncedQuoteId",
  "Order__r.OrderNumber",
  "Order__r.Customer_Order_Name__c",
  "Order__r.Print_Date__c",
  "Order__r.Account.Name",
  "Order__r.Printer__r.Name",
  "Order__r.Status",
  "Order__r.Order_Substatus__c",
  "Order__r.Receiving_Status__c",
  "Order__r.Partial_Check_in_Missing_Items__c",
  "Order__r.Print_Setup_Timer__c",
  "Order__r.Production_Timer__c",
  "Order__r.Misprint__c",
  "Order__r.Misprint_Details__c",
  "Order__r.TotalQtyMisprints__c",
  "Order__r.Packaging_Count__c",
  "Order__r.Production_Notes__c",
  "Order__r.Shipping_Delivery__c",
  "Order__r.Shipping_Label_Printed__c",
  "Order__r.ShippingAddress",
  "Order__r.Special_Notes__c",
  "Order__r.Specifications_for_Printing__c",
];

export async function onRequestGet({ env }) {
  try {
    const v = apiVersion(env);
    const statusList = BOARD_STATUSES.map((s) => `'${s}'`).join(",");
    const soql =
      `SELECT ${PM_FIELDS.join(", ")}, ${ORDER_FIELDS.join(", ")} ` +
      `FROM Production_Method__c ` +
      `WHERE Status__c IN (${statusList}) AND Order__c != null`;
    const path = `/services/data/${v}/query/?q=${encodeURIComponent(soql)}`;
    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Salesforce query failed", resp.status, JSON.stringify(data));
      return jsonError("query_failed", resp.status);
    }

    // Group method rows into one object per Order__c. Order-level fields
    // are identical across sibling methods on the same order, so they're
    // taken from the first row seen for that order; every row still adds
    // its own entry to ProductionMethods.
    const byOrder = new Map();
    (data.records || []).forEach((pm) => {
      const o = pm.Order__r || {};
      let order = byOrder.get(pm.Order__c);
      if (!order) {
        order = {
          Id: o.Id || pm.Order__c,
          GOA_Order_Number__c: o.GOA_Order_Number__c,
          OpportunityId: o.OpportunityId,
          Opportunity: o.Opportunity,
          OrderNumber: o.OrderNumber,
          Customer_Order_Name__c: o.Customer_Order_Name__c,
          Print_Date__c: o.Print_Date__c,
          Account: o.Account,
          Printer__r: o.Printer__r,
          Status: o.Status,
          Order_Substatus__c: o.Order_Substatus__c,
          Receiving_Status__c: o.Receiving_Status__c,
          Partial_Check_in_Missing_Items__c: o.Partial_Check_in_Missing_Items__c,
          Print_Setup_Timer__c: o.Print_Setup_Timer__c,
          Production_Timer__c: o.Production_Timer__c,
          Misprint__c: o.Misprint__c,
          Misprint_Details__c: o.Misprint_Details__c,
          TotalQtyMisprints__c: o.TotalQtyMisprints__c,
          Packaging_Count__c: o.Packaging_Count__c,
          Production_Notes__c: o.Production_Notes__c,
          Shipping_Delivery__c: o.Shipping_Delivery__c,
          Shipping_Label_Printed__c: o.Shipping_Label_Printed__c,
          ShippingAddress: o.ShippingAddress,
          Special_Notes__c: o.Special_Notes__c,
          Specifications_for_Printing__c: o.Specifications_for_Printing__c,
          DesignMockupUrl: null,
          OrderItems: { totalSize: 0, done: true, records: [] },
          ProductionMethods: [],
        };
        byOrder.set(pm.Order__c, order);
      }
      order.ProductionMethods.push({
        Id: pm.Id,
        Type__c: pm.Type__c,
        Placement__c: pm.Placement__c || null,
        Placements: pm.Placements__c
          ? pm.Placements__c.split(";").filter(Boolean)
          : (pm.Placement__c ? [pm.Placement__c] : []),
        Status__c: pm.Status__c,
        Vendor: (pm.Vendor__r && pm.Vendor__r.Name) || null,
        Films_Printed__c: !!pm.Films_Printed__c,
        Screens_Completed__c: !!pm.Screens_Completed__c,
        Mix_Inks__c: !!pm.Mix_Inks__c,
        Digitize_File__c: !!pm.Digitize_File__c,
        Thread_Color_Materials__c: !!pm.Thread_Color_Materials__c,
        Transfers_Received__c: !!pm.Transfers_Received__c,
        Transfers_Ready__c: !!pm.Transfers_Ready__c,
      });
    });

    const orders = Array.from(byOrder.values());

    // OrderItems is a child of Order, not of Production_Method__c, so it
    // can no longer ride along as a nested subquery now that
    // Production_Method__c is the query root -- fetch it in one batched
    // follow-up keyed by order Id instead, same pattern as the mockup
    // lookup below. Fails open (empty items) so a transient error never
    // breaks a card, just its size/qty display.
    const orderIds = orders.map((o) => o.Id).filter(Boolean);
    if (orderIds.length) {
      try {
        const quoted = orderIds.map((oid) => `'${oid}'`).join(",");
        const soqlItems =
          `SELECT OrderId, Product2.Name, Color__c, Size__c, Quantity ` +
          `FROM OrderItem WHERE OrderId IN (${quoted})`;
        const pathItems = `/services/data/${v}/query/?q=${encodeURIComponent(soqlItems)}`;
        const respItems = await sfFetch(env, pathItems);
        const dataItems = await respItems.json();
        if (respItems.ok) {
          const itemsByOrder = new Map();
          (dataItems.records || []).forEach((it) => {
            const arr = itemsByOrder.get(it.OrderId) || [];
            arr.push(it);
            itemsByOrder.set(it.OrderId, arr);
          });
          orders.forEach((o) => {
            const recs = itemsByOrder.get(o.Id) || [];
            o.OrderItems = { totalSize: recs.length, done: true, records: recs };
          });
        } else {
          console.error("Order item fetch failed", respItems.status, JSON.stringify(dataItems));
        }
      } catch (e) {
        console.error("Order item fetch error", e);
      }
    }

    const mockups = await fetchMockupsByOpportunity(
      env,
      orders.map((o) => o.OpportunityId),
    );
    orders.forEach((o) => {
      o.DesignMockupUrl = mockups.get(o.OpportunityId) || null;
    });

    // Match the old ORDER BY Print_Date__c ASC (SOQL's default puts nulls
    // first on an ascending sort), so card order within a column reads the
    // same as before.
    orders.sort((a, b) => {
      const da = a.Print_Date__c, db = b.Print_Date__c;
      if (!da && !db) return 0;
      if (!da) return -1;
      if (!db) return 1;
      return da < db ? -1 : da > db ? 1 : 0;
    });

    return Response.json(
      { totalSize: orders.length, done: true, records: orders },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
