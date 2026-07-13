/**
 * /api/inventory?type=ink|screen   (GET reads, POST writes)
 *
 * Simple manual inventory for the ink and screen stations. There's no Salesforce
 * source for this, so it's stored in a Cloudflare KV namespace bound as
 * `INVENTORY` (one JSON blob per type). If KV has nothing yet, the SEED below is
 * returned so the list shows up on first load; the first save persists it.
 *
 * SETUP: create a KV namespace and bind it to this Pages project with the
 * variable name INVENTORY (Settings -> Bindings/Functions -> KV namespace
 * bindings, Production), then redeploy.
 *
 * Open access, like the rest of the station API — the real perimeter is
 * Cloudflare Access in front of /api/*.
 */
import { jsonError } from "../_sf.js";

const THREAD_STATUS = ["In-Stock (8+)", "REORDER (7-)"]; // toggle values

const SEED = {
  // Order below is the canonical list order. Low items sort to the top in the
  // UI, but the stored order stays as-is. qty is "buckets on hand".
  ink: [
    // reorderAt = threshold at which the LOW flag triggers.
    // High-volume inks (white, black, bases) have higher thresholds.
    { name: "Rio Mix White Ink",          qty: 4,  reorderAt: 3 },
    { name: "Rio Deep Black Ink",         qty: 4,  reorderAt: 3 },
    { name: "Rio Sunshine Yellow Ink",    qty: 1,  reorderAt: 1 },
    { name: "Rio Blaze Orange Ink",       qty: 3,  reorderAt: 1 },
    { name: "Rio Mix Red Ink",            qty: 2,  reorderAt: 1 },
    { name: "Rio Golden Yellow Ink",      qty: 2,  reorderAt: 1 },
    { name: "Rio Barberry Maroon Ink",    qty: 1,  reorderAt: 1 },
    { name: "Rio Forest Green Ink",       qty: 3,  reorderAt: 1 },
    { name: "Rio Aquamarine Ink",         qty: 3,  reorderAt: 1 },
    { name: "Rio Deep Violet Ink",        qty: 1,  reorderAt: 1 },
    { name: "Rio Majestic Magenta Ink",   qty: 2,  reorderAt: 1 },
    { name: "Rio Indigo Blue Ink",        qty: 3,  reorderAt: 1 },
    { name: "Rio Midnight Blue Ink",      qty: 1,  reorderAt: 1 },
    { name: "Rio Electric Red Ink",       qty: 2,  reorderAt: 1 },
    { name: "Rio Electric Pink Ink",      qty: 2,  reorderAt: 1 },
    { name: "Rio Electric Purple Ink",    qty: 2,  reorderAt: 1 },
    { name: "Rio Electric Blue Ink",      qty: 2,  reorderAt: 1 },
    { name: "Rio Electric Yellow Ink",    qty: 2,  reorderAt: 1 },
    { name: "7506 C LC 50/50 White Mix",  qty: 4,  reorderAt: 3 },
    { name: "Rival Sport LC Defender",    qty: 3,  reorderAt: 2 },
    { name: "5 Gallon LC Black Ink",      qty: 2,  reorderAt: 2 },
    { name: "Fashion Soft Base",          qty: 3,  reorderAt: 2 },
    { name: "Puff Additive",              qty: 3,  reorderAt: 1 },
    { name: "5 Gallon Bolt White",        qty: 2,  reorderAt: 2 },
  ],
  screen: [
    // reorderAt = minimum count before flagging as low.
    { mesh: "110", qty: 6,  reorderAt: 3 },
    { mesh: "125", qty: 23, reorderAt: 8 },
    { mesh: "156", qty: 60, reorderAt: 15 },
    { mesh: "180", qty: 14, reorderAt: 5 },
    { mesh: "196", qty: 9,  reorderAt: 4 },
    { mesh: "230", qty: 28, reorderAt: 8 },
    { mesh: "305", qty: 7,  reorderAt: 3 },
  ],
  // REAL DATA from the Thread Inventory sheet (2026-07-08), duplicates merged to
  // one row per thread number (110 unique). Two-state status the user toggles --
  // no counts. If any duplicate of a number was marked REORDER, the merged row
  // stays REORDER. Kept in sheet order.
  thread: [
    { name: "1980", status: "In-Stock (8+)" },
    { name: "1796", status: "REORDER (7-)" },
    { name: "1794", status: "In-Stock (8+)" },
    { name: "1790", status: "In-Stock (8+)" },
    { name: "1706", status: "In-Stock (8+)" },
    { name: "1940", status: "REORDER (7-)" },
    { name: "1867", status: "In-Stock (8+)" },
    { name: "1748", status: "In-Stock (8+)" },
    { name: "1749", status: "In-Stock (8+)" },
    { name: "1988", status: "In-Stock (8+)" },
    { name: "1851", status: "In-Stock (8+)" },
    { name: "1903", status: "In-Stock (8+)" },
    { name: "1902", status: "In-Stock (8+)" },
    { name: "1905", status: "REORDER (7-)" },
    { name: "1652", status: "In-Stock (8+)" },
    { name: "1685", status: "In-Stock (8+)" },
    { name: "1799", status: "REORDER (7-)" },
    { name: "1694", status: "In-Stock (8+)" },
    { name: "1893", status: "In-Stock (8+)" },
    { name: "1827", status: "In-Stock (8+)" },
    { name: "1675", status: "REORDER (7-)" },
    { name: "1528", status: "In-Stock (8+)" },
    { name: "1842", status: "In-Stock (8+)" },
    { name: "1642", status: "In-Stock (8+)" },
    { name: "1767", status: "In-Stock (8+)" },
    { name: "1967", status: "In-Stock (8+)" },
    { name: "1944", status: "In-Stock (8+)" },
    { name: "1623", status: "REORDER (7-)" },
    { name: "1624", status: "In-Stock (8+)" },
    { name: "1771", status: "In-Stock (8+)" },
    { name: "1683", status: "In-Stock (8+)" },
    { name: "1626", status: "In-Stock (8+)" },
    { name: "1724", status: "In-Stock (8+)" },
    { name: "1670", status: "In-Stock (8+)" },
    { name: "1673", status: "In-Stock (8+)" },
    { name: "1939", status: "REORDER (7-)" },
    { name: "1672", status: "In-Stock (8+)" },
    { name: "1725", status: "In-Stock (8+)" },
    { name: "1755", status: "In-Stock (8+)" },
    { name: "1621", status: "In-Stock (8+)" },
    { name: "1678", status: "In-Stock (8+)" },
    { name: "1978", status: "In-Stock (8+)" },
    { name: "1801", status: "REORDER (7-)" },
    { name: "1803", status: "REORDER (7-)" },
    { name: "1661", status: "REORDER (7-)" },
    { name: "1738", status: "In-Stock (8+)" },
    { name: "1938", status: "In-Stock (8+)" },
    { name: "1854", status: "In-Stock (8+)" },
    { name: "1884", status: "In-Stock (8+)" },
    { name: "1885", status: "In-Stock (8+)" },
    { name: "1728", status: "In-Stock (8+)" },
    { name: "1144", status: "In-Stock (8+)" },
    { name: "1745", status: "In-Stock (8+)" },
    { name: "1559", status: "In-Stock (8+)" },
    { name: "1958", status: "In-Stock (8+)" },
    { name: "1812", status: "In-Stock (8+)" },
    { name: "1999", status: "REORDER (7-)" },
    { name: "1635", status: "In-Stock (8+)" },
    { name: "1638", status: "In-Stock (8+)" },
    { name: "1821", status: "In-Stock (8+)" },
    { name: "1779", status: "In-Stock (8+)" },
    { name: "1639", status: "In-Stock (8+)" },
    { name: "1839", status: "In-Stock (8+)" },
    { name: "1734", status: "In-Stock (8+)" },
    { name: "1910", status: "In-Stock (8+)" },
    { name: "1990", status: "In-Stock (8+)" },
    { name: "1548", status: "In-Stock (8+)" },
    { name: "1815", status: "In-Stock (8+)" },
    { name: "1711", status: "In-Stock (8+)" },
    { name: "1922", status: "In-Stock (8+)" },
    { name: "1677", status: "In-Stock (8+)" },
    { name: "1541", status: "In-Stock (8+)" },
    { name: "1662", status: "In-Stock (8+)" },
    { name: "1747", status: "In-Stock (8+)" },
    { name: "1645", status: "In-Stock (8+)" },
    { name: "1562", status: "In-Stock (8+)" },
    { name: "1960", status: "REORDER (7-)" },
    { name: "1964", status: "In-Stock (8+)" },
    { name: "1540", status: "In-Stock (8+)" },
    { name: "1532", status: "In-Stock (8+)" },
    { name: "1521", status: "In-Stock (8+)" },
    { name: "1945", status: "In-Stock (8+)" },
    { name: "1800", status: "In-Stock (8+)" },
    { name: "1817", status: "In-Stock (8+)" },
    { name: "1616", status: "In-Stock (8+)" },
    { name: "1918", status: "In-Stock (8+)" },
    { name: "1568", status: "In-Stock (8+)" },
    { name: "1840", status: "In-Stock (8+)" },
    { name: "1664", status: "In-Stock (8+)" },
    { name: "1594", status: "In-Stock (8+)" },
    { name: "1761", status: "In-Stock (8+)" },
    { name: "1726", status: "In-Stock (8+)" },
    { name: "1915", status: "In-Stock (8+)" },
    { name: "1634", status: "In-Stock (8+)" },
    { name: "1849", status: "In-Stock (8+)" },
    { name: "1792", status: "In-Stock (8+)" },
    { name: "1545", status: "In-Stock (8+)" },
    { name: "1932", status: "In-Stock (8+)" },
    { name: "1703", status: "In-Stock (8+)" },
    { name: "1968", status: "In-Stock (8+)" },
    { name: "1753", status: "In-Stock (8+)" },
    { name: "1772", status: "In-Stock (8+)" },
    { name: "1778", status: "In-Stock (8+)" },
    { name: "1921", status: "In-Stock (8+)" },
    { name: "1710", status: "In-Stock (8+)" },
    { name: "1962", status: "REORDER (7-)" },
    { name: "1657", status: "In-Stock (8+)" },
    { name: "1969", status: "REORDER (7-)" },
    { name: "1564", status: "In-Stock (8+)" },
    { name: "1668", status: "In-Stock (8+)" },
  ],
};

const clampQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function sanitize(type, items) {
  if (!Array.isArray(items)) return null;
  return items.map((it) => {
    const qty = clampQty(it.qty);
    // reorderAt is optional but preserved if present (must be a non-negative integer).
    const reorderAt = it.reorderAt != null ? Math.max(0, Math.floor(Number(it.reorderAt) || 0)) : undefined;
    if (type === "ink") {
      const out = { name: String(it.name || "").slice(0, 120), qty };
      if (reorderAt !== undefined) out.reorderAt = reorderAt;
      return out;
    }
    if (type === "thread")
      return {
        name: String(it.name || "").slice(0, 120),
        status: THREAD_STATUS.includes(it.status) ? it.status : THREAD_STATUS[0],
      };
    // screen
    const out = { mesh: String(it.mesh || "").slice(0, 20), qty };
    if (reorderAt !== undefined) out.reorderAt = reorderAt;
    return out;
  });
}

export async function onRequestGet({ env, request }) {
  const type = (new URL(request.url).searchParams.get("type") || "").toLowerCase();
  if (!SEED[type]) return jsonError("unknown_type", 400);
  if (!env.INVENTORY) return jsonError("kv_not_bound", 500);
  try {
    const stored = await env.INVENTORY.get("inventory:" + type);
    const items = stored ? JSON.parse(stored) : SEED[type];
    return Response.json({ type, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.INVENTORY) return jsonError("kv_not_bound", 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", 400);
  }
  const type = String(body.type || "").toLowerCase();
  if (!SEED[type]) return jsonError("unknown_type", 400);

  const clean = sanitize(type, body.items);
  if (!clean) return jsonError("invalid_items", 400);

  try {
    await env.INVENTORY.put("inventory:" + type, JSON.stringify(clean));
    return Response.json({ ok: true, type, items: clean }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
