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

const SEED = {
  // Order below is the canonical list order. Low items sort to the top in the
  // UI, but the stored order stays as-is. qty is "buckets on hand".
  ink: [
    { name: "Rio Mix White Ink", qty: 4 },
    { name: "Rio Deep Black Ink", qty: 4 },
    { name: "Rio Sunshine Yellow Ink", qty: 1 },
    { name: "Rio Blaze Orange Ink", qty: 3 },
    { name: "Rio Mix Red Ink", qty: 2 },
    { name: "Rio Golden Yellow Ink", qty: 2 },
    { name: "Rio Barberry Maroon Ink", qty: 1 },
    { name: "Rio Forest Green Ink", qty: 3 },
    { name: "Rio Aquamarine Ink", qty: 3 },
    { name: "Rio Deep Violet Ink", qty: 1 },
    { name: "Rio Majestic Magenta Ink", qty: 2 },
    { name: "Rio Indigo Blue Ink", qty: 3 },
    { name: "Rio Midnight Blue Ink", qty: 1 },
    { name: "Rio Electric Red Ink", qty: 2 },
    { name: "Rio Electric Pink Ink", qty: 2 },
    { name: "Rio Electric Purple Ink", qty: 2 },
    { name: "Rio Electric Blue Ink", qty: 2 },
    { name: "Rio Electric Purple Ink", qty: 2 },
    { name: "Rio Electric Yellow Ink", qty: 2 },
    { name: "7506 C LC 50/50 White Mix", qty: 4 },
    { name: "Rival Sport LC Defender", qty: 3 },
    { name: "5 Gallon LC Black Ink", qty: 2 },
    { name: "Fashion Soft Base", qty: 3 },
    { name: "Puff Additive", qty: 3 },
    { name: "5 Gallon Bolt White", qty: 2 },
  ],
  screen: [
    { mesh: "110", qty: 6 },
    { mesh: "125", qty: 23 },
    { mesh: "156", qty: 60 },
    { mesh: "180", qty: 14 },
    { mesh: "196", qty: 9 },
    { mesh: "230", qty: 28 },
    { mesh: "305", qty: 7 },
  ],
};

const clampQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

function sanitize(type, items) {
  if (!Array.isArray(items)) return null;
  return items.map((it) =>
    type === "ink"
      ? { name: String(it.name || "").slice(0, 120), qty: clampQty(it.qty) }
      : { mesh: String(it.mesh || "").slice(0, 20), qty: clampQty(it.qty) },
  );
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
