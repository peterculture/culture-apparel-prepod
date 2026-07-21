/**
 * Station auth + config for the shop-worker dashboard.  Mirrors how _sf.js
 * abstracts Salesforce auth: shared plumbing that the station endpoints import.
 *
 * THE MODEL
 *   A worker at a station tablet POSTs the station's PIN to /api/station-login.
 *   If the PIN matches, we hand back a SIGNED token in an HttpOnly cookie. Every
 *   station endpoint (schedule read, status write) then verifies that token
 *   server-side and resolves which station the caller is. The browser can't
 *   forge or edit the token because it's HMAC-signed with a secret only the
 *   Worker knows -- so "station=ink" can't just be typed into a cookie.
 *
 * SECRETS (set in the Cloudflare Pages project settings, NEVER in the repo)
 *   STATION_TOKEN_SECRET  a long random string used to sign/verify tokens
 *   STATION_PINS          JSON map of station -> PIN, e.g. {"ink":"4821"}
 *
 * This is APP-level auth. It is NOT a replacement for the Cloudflare Access
 * lockdown: Access still belongs in front of /api/* so the raw endpoints aren't
 * publicly reachable at all. Defense in depth, not either/or -- and the write
 * endpoint especially must not go live until Access is on.
 */

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // ~one shift; re-PIN after that
const COOKIE_NAME = "station_token";
const enc = new TextEncoder();

/* ---- base64url helpers ---- */
function b64urlFromBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromString(str) {
  return b64urlFromBytes(enc.encode(str));
}
function bytesFromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function stringFromB64url(s) {
  return new TextDecoder().decode(bytesFromB64url(s));
}

/* ---- HMAC-SHA256 via Web Crypto (available in the Workers runtime) ---- */
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}

/** Constant-time string compare (avoids leaking via early mismatch). */
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---- token issue / verify ---- */
export async function signStationToken(env, station) {
  const secret = env.STATION_TOKEN_SECRET;
  if (!secret) throw new Error("STATION_TOKEN_SECRET not set");
  const payload = b64urlFromString(
    JSON.stringify({
      s: station,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    }),
  );
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

/** Verified station string (e.g. "ink"), or null if missing/tampered/expired. */
export async function verifyStationToken(env, request) {
  const secret = env.STATION_TOKEN_SECRET;
  if (!secret) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmac(secret, payload);
  if (!safeEqual(sig, expected)) return null;

  let data;
  try {
    data = JSON.parse(stringFromB64url(payload));
  } catch {
    return null;
  }
  if (!data || typeof data.s !== "string") return null;
  if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return data.s;
}

/* ---- cookie helpers ---- */
export function stationCookie(token) {
  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${TOKEN_TTL_SECONDS}`,
  ].join("; ");
}
export function clearStationCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * PER-STATION CONFIG
 *
 * Only INK is filled in -- every field below was verified in Object Manager
 * or the Dev Console (2026-07-07), not guessed. Screen / Garment / Film each
 * need the same treatment before they're added: their own field names verified,
 * AND the station->Type__c mapping settled (the named stations are Ink / Screen
 * / Garment / Film, but Type__c is Ink / Screen / Thread / Digitization /
 * Transfer -- those don't line up one-to-one).
 * ------------------------------------------------------------------ */
export const STATION_CONFIG = {
  ink: {
    type: "Ink", // Pre_Production_Item__c.Type__c value
    subStatusField: "Ink_Sub_Status__c",
    statusViaFlow: false, // no SF flow — the endpoint derives + writes Status__c

    // Fields the schedule SELECTs. Order details come up the verified two-hop
    // path: Production_Method__r (lookup) -> Order__r (master-detail, STANDARD
    // Order -- the same 801... records the dashboard renders).
    selectFields: [
      "Id",
      "Pantone_Color__c",
      "Ink_Sub_Status__c",
      "Status__c",
      "Notes__c",
      "Production_Method__r.Order__r.Id",
      "Production_Method__r.Order__r.GOA_Order_Number__c",
      "Production_Method__r.Order__r.Customer_Order_Name__c",
      "Production_Method__r.Order__r.Name",
      "Production_Method__r.Order__r.Print_Date__c",
      "Production_Method__r.Order__r.OpportunityId", // <-- for the Design__c mockup lookup
      "Production_Method__r.Placement__c", // <-- which decoration location this ink job is for
    ],
    orderBy: "Production_Method__r.Order__r.Print_Date__c NULLS LAST, Production_Method__r.Order__r.Name",

    // The steps a worker taps through. A blank Ink_Sub_Status__c is treated as
    // the start (== "Not Started") -- several live rows have it empty.
    subStatusFlow: ["Not Started", "Pantone Label Printed", "Mixing", "Mixed"],

    // sub-status -> Status__c roll-up. No Salesforce flow maintains Status__c
    // (confirmed 2026-07-07), so the write derives it. Matches the live data:
    // "Pantone Label Printed" rows sit at "In Progress"; "Mixed" => "Ready".
    statusMap: {
      "Not Started": "Not Started",
      "Pantone Label Printed": "In Progress",
      "Mixing": "In Progress",
      "Mixed": "Ready",
    },

    // Terminal Status__c; the schedule excludes items at this value.
    doneStatus: "Ready",

    // AUTO ROLL-UP: when all Ink items on an order reach "Mixed", the Order's
    // Mix_Inks__c checkbox is set true automatically (same pattern as Transfer).
    orderRollup: [
      { field: "Mix_Inks__c", atOrAfter: "Mixed" },
    ],
  },

  // ── SCREEN STATION ("The Blue Lagoon") ──
  // Field names + sub-status values come from the existing worker board
  // (PP_SCREEN_SUB, Screen_Sub_Status__c, Mesh_Count__c in pre-production.html), so
  // they're verified-by-existing-use. TWO THINGS STILL NEED YOUR SIGN-OFF
  // before workers use this (same care as ink):
  //   1. the sub-status ORDER below (taken from the pre-production.html dropdown order)
  //   2. the statusMap roll-up (inferred from the names, NOT yet seen in data)
  // Run the GROUP BY probe from chat to confirm 2 against live records.
  screen: {
    type: "Screen",
    subStatusField: "Screen_Sub_Status__c",
    // Was `true` (assuming a Salesforce flow rolled up Status__c from the
    // sub-status). That assumption was never actually confirmed live, and in
    // practice Status__c was going stale on this path -- screens would sit on
    // the station board forever even after reaching "Ready for Print", since
    // the board's query filters on Status__c, not the sub-status. The app now
    // owns this roll-up directly (statusMap below), same as ink, so it can't
    // depend on a flow that may not exist.
    statusViaFlow: false,

    selectFields: [
      "Id",
      "Mesh_Count__c",
      "Screen_Sub_Status__c",
      "Status__c",
      "Notes__c",
      "Production_Method__r.Order__r.Id",
      "Production_Method__r.Order__r.GOA_Order_Number__c",
      "Production_Method__r.Order__r.Customer_Order_Name__c",
      "Production_Method__r.Order__r.Name",
      "Production_Method__r.Order__r.Print_Date__c",
      "Production_Method__r.Order__r.OpportunityId", // <-- for the Design__c mockup lookup
      "Production_Method__r.Placement__c", // <-- which decoration location this screen is for
    ],
    orderBy: "Production_Method__r.Order__r.Print_Date__c NULLS LAST, Production_Method__r.Order__r.Name",

    // Screen-making flow starts at Needs Emulsion; "Not Clean" (cleaning) is a
    // separate process handled elsewhere, so it's out of this pipeline. A blank
    // Screen_Sub_Status__c is treated as the start (Needs Emulsion).
    subStatusFlow: ["Needs Emulsion", "Ready for Exposure", "Needs Tape", "Ready for Print"],

    // Roll-up the app writes itself (statusViaFlow: false, see above): Needs
    // Emulsion => Not Started, the two middle stages => In Progress, Ready for
    // Print => Ready (drops the screen off the board). Updated 2026-07-07.
    statusMap: {
      "Needs Emulsion": "Not Started",
      "Ready for Exposure": "In Progress",
      "Needs Tape": "In Progress",
      "Ready for Print": "Ready",
    },

    doneStatus: "Ready",

    // AUTO ROLL-UP: when all Screen items on an order reach "Ready for Print",
    // the Order's Screens_Completed__c checkbox is set true automatically.
    orderRollup: [
      { field: "Screens_Completed__c", atOrAfter: "Ready for Print" },
    ],
  },

  // ── TRANSFER STATION (heat-press transfers) ──
  // Field names + sub-status values come from the existing worker board
  // (PP_TRANSFER_SUB, Transfers_Sub_Status__c, Transfer_Type__c in pre-production.html),
  // so they're verified-by-existing-use. STILL NEEDS YOUR SIGN-OFF (same as ink
  // and screen did):
  //   1. the sub-status ORDER below
  //   2. the statusMap roll-up (inferred from the names, not yet seen in data)
  //   3. whether a Salesforce flow owns Status__c for transfers -> set
  //      statusViaFlow accordingly (see below).
  transfer: {
    type: "Transfer",
    subStatusField: "Transfers_Sub_Status__c",

    // Was `true` (assumed a Salesforce flow rolled up Status__c from the
    // sub-status). Same problem as screen: unconfirmed live, and Status__c
    // could go stale. The app now derives + writes it directly, every time,
    // regardless of which board made the edit.
    statusViaFlow: false,

    selectFields: [
      "Id",
      "Transfer_Type__c",
      "Transfers_Sub_Status__c",
      "Status__c",
      "Notes__c",
      "Production_Method__r.Order__r.Id",
      "Production_Method__r.Order__r.GOA_Order_Number__c",
      "Production_Method__r.Order__r.Customer_Order_Name__c",
      "Production_Method__r.Order__r.Name",
      "Production_Method__r.Order__r.Print_Date__c",
      "Production_Method__r.Placement__c", // <-- which decoration location this transfer is for
    ],
    orderBy: "Production_Method__r.Order__r.Print_Date__c NULLS LAST, Production_Method__r.Order__r.Name",

    // Pipeline order confirmed 2026-07-07. Blank Transfers_Sub_Status__c is
    // treated as the start (Not Received).
    subStatusFlow: ["Not Received", "Transfers Received", "Transfers Cut/Ready"],

    // Roll-up CONFIRMED 2026-07-07; the app writes it directly (statusViaFlow:
    // false, see above): Not Received => Not Started, Transfers Received =>
    // In Progress, Transfers Cut/Ready => Ready (drops off the board).
    statusMap: {
      "Not Received": "Not Started",
      "Transfers Received": "In Progress",
      "Transfers Cut/Ready": "Ready",
    },

    doneStatus: "Ready",

    // ROLL-UP TO THE STANDARD ORDER: after a transfer item's sub-status changes,
    // the endpoint recomputes these Order checkboxes (the ones the MAIN dashboard
    // heat-press checklist shows). Each is true iff EVERY transfer item on that
    // order has reached the given stage or later; recomputed both ways, so a
    // "Transfer Error" reset unchecks it again. Fields verified via pre-production.html.
    orderRollup: [
      { field: "Transfers_Received__c", atOrAfter: "Transfers Received" },
      { field: "Transfers_Ready__c",    atOrAfter: "Transfers Cut/Ready" },
    ],
  },

  // ── GARMENT COUNT-IN STATION ──
  // Different from the other three: NO pre-prod item and NO production method.
  // It works off the standard Order directly — the board reuses /api/orders and
  // the write goes to /api/update-order-receiving (which targets the Order).
  // `source: "order"` tells the client to use that path. This config is what
  // /api/station-login checks (so the garment PIN is accepted) and what the
  // receiving-write endpoint validates against.
  garment: {
    source: "order",
    field: "Receiving_Status__c",
    // Allowed picklist values (same set the main dashboard uses). Garment is
    // NOT a strict pipeline -- unlike ink/screen/transfer, the client lets a
    // worker jump directly to any of these four (e.g. undo "Staged" back to
    // "Partial" without stepping through every stage in between).
    statuses: ["Not Received", "Partial", "Counted In", "Staged"],
    doneStatus: "Staged", // board hides orders at this value
    // Free-text "missing count-in" note; kept only while at "Partial".
    missingField: "Partial_Check_in_Missing_Items__c",
    missingAtStage: "Partial",
  },
};

/**
 * Given a sub-status FIELD NAME (e.g. "Screen_Sub_Status__c") and the value
 * just written to it, returns the Status__c value that field's owning station
 * config says it should roll up to -- or null if the field/value isn't part
 * of a tracked pipeline (e.g. Screen's "Not Clean", which sits outside this
 * flow). A blank/undefined value is treated as that pipeline's first stage,
 * same convention used everywhere else in this file.
 *
 * Single source of truth for the sub-status -> Status__c roll-up, used by
 * BOTH write paths that can set one of these fields: the station-tablet
 * endpoint (update-item-status) and the pre-production worker/management
 * board's item editor (pre-production-items/[id].js). Before this existed,
 * only the tablet path derived Status__c (and only for ink) -- editing a
 * screen/ink/transfer item's sub-status from the pre-production board left
 * Status__c stale, which then broke anything keyed off Status__c (the
 * station board's "still open" filter, the order-level checklist rollup).
 */
export function statusForSubStatus(subStatusField, value) {
  for (const key of Object.keys(STATION_CONFIG)) {
    const cfg = STATION_CONFIG[key];
    if (cfg.subStatusField !== subStatusField || !cfg.statusMap) continue;
    const v = value || (cfg.subStatusFlow && cfg.subStatusFlow[0]);
    return cfg.statusMap[v] || null;
  }
  return null;
}
