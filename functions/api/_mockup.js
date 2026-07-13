/**
 * Shared helper: look up the production mockup image for a set of Opportunities.
 *
 * SCHEMA (verified in Setup, 2026-07-13):
 *   Design__c (Singular Label "Design Version", Plural Label "Designs")
 *     - Opportunity__c   Master-Detail(Opportunity), Child Relationship Name "Designs"
 *     - Mockup_URL__c    URL(255) — a public image link. Staff drop the mockup image
 *                        into the "Vault" tab on the Design record (Cloud Files,
 *                        marked Public); that flow is what populates this field.
 *                        We just read the field — no dependency on the Vault's
 *                        internals or on the separate Apex class that copies design
 *                        files onto the Order, so this stays declarative and works
 *                        even if that Apex path changes.
 *
 *   Order relates to Opportunity via the standard OpportunityId lookup (relationship
 *   name "Opportunity", already used elsewhere as Opportunity.SyncedQuoteId).
 *
 * SOQL can't nest a child subquery under a dot-walked parent (e.g. you can't do
 * Order -> Opportunity.(SELECT ... FROM Designs__r) in one query), so callers
 * fetch OpportunityId alongside their normal fields, then call this helper with
 * the list of ids to get a second, small query merged in server-side.
 */
import { sfFetch, apiVersion } from "./_sf.js";

/**
 * @param {object} env
 * @param {string[]} opportunityIds
 * @returns {Promise<Map<string,string>>} Opportunity Id -> mockup image URL
 */
export async function fetchMockupsByOpportunity(env, opportunityIds) {
  const ids = [...new Set((opportunityIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const quoted = ids.map((id) => `'${id}'`).join(",");
  const soql =
    `SELECT Opportunity__c, Mockup_URL__c FROM Design__c ` +
    `WHERE Opportunity__c IN (${quoted}) AND Mockup_URL__c != null ` +
    `ORDER BY LastModifiedDate DESC`;
  const path = `/services/data/${apiVersion(env)}/query/?q=${encodeURIComponent(soql)}`;

  try {
    const resp = await sfFetch(env, path);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Design mockup query failed", resp.status, JSON.stringify(data));
      return new Map();
    }
    const map = new Map();
    for (const rec of data.records || []) {
      if (!map.has(rec.Opportunity__c)) map.set(rec.Opportunity__c, rec.Mockup_URL__c);
    }
    return map;
  } catch (err) {
    console.error("Design mockup lookup error", err);
    return new Map();
  }
}
