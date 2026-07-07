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
  },

  // ── SCREEN STATION ("The Blue Lagoon") ──
  // Field names + sub-status values come from the existing worker board
  // (PP_SCREEN_SUB, Screen_Sub_Status__c, Mesh_Count__c in index.html), so
  // they're verified-by-existing-use. TWO THINGS STILL NEED YOUR SIGN-OFF
  // before workers use this (same care as ink):
  //   1. the sub-status ORDER below (taken from the index.html dropdown order)
  //   2. the statusMap roll-up (inferred from the names, NOT yet seen in data)
  // Run the GROUP BY probe from chat to confirm 2 against live records.
  screen: {
    type: "Screen",
    subStatusField: "Screen_Sub_Status__c",
    statusViaFlow: true, // a SF flow rolls Status__c from Screen_Sub_Status__c,
                         // so the endpoint writes ONLY the sub-status and lets
                         // the flow cascade Status__c (confirmed 2026-07-07).

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
    ],
    orderBy: "Production_Method__r.Order__r.Print_Date__c NULLS LAST, Production_Method__r.Order__r.Name",

    // Screen-making flow starts at Needs Emulsion; "Not Clean" (cleaning) is a
    // separate process handled elsewhere, so it's out of this pipeline. A blank
    // Screen_Sub_Status__c is treated as the start (Needs Emulsion).
    subStatusFlow: ["Needs Emulsion", "Ready for Exposure", "Needs Tape", "Ready for Print"],

    // Roll-up is OWNED BY A SALESFORCE FLOW (statusViaFlow: true) — kept here for
    // reference only; the endpoint does NOT write Status__c for screen. This MUST
    // match the flow: Needs Emulsion => Not Started, the two middle => In Progress,
    // Ready for Print => Ready (drops the screen off the board). Updated 2026-07-07.
    statusMap: {
      "Needs Emulsion": "Not Started",
      "Ready for Exposure": "In Progress",
      "Needs Tape": "In Progress",
      "Ready for Print": "Ready",
    },

    doneStatus: "Ready",
  },

  // ── TRANSFER STATION (heat-press transfers) ──
  // Field names + sub-status values come from the existing worker board
  // (PP_TRANSFER_SUB, Transfers_Sub_Status__c, Transfer_Type__c in index.html),
  // so they're verified-by-existing-use. STILL NEEDS YOUR SIGN-OFF (same as ink
  // and screen did):
  //   1. the sub-status ORDER below
  //   2. the statusMap roll-up (inferred from the names, not yet seen in data)
  //   3. whether a Salesforce flow owns Status__c for transfers -> set
  //      statusViaFlow accordingly (see below).
  transfer: {
    type: "Transfer",
    subStatusField: "Transfers_Sub_Status__c",

    // A Salesforce flow rolls Status__c from Transfers_Sub_Status__c (confirmed
    // 2026-07-07), so the endpoint writes ONLY the sub-status and lets the flow
    // own Status__c — same pattern as screen.
    statusViaFlow: true,

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
    ],
    orderBy: "Production_Method__r.Order__r.Print_Date__c NULLS LAST, Production_Method__r.Order__r.Name",

    // Pipeline order confirmed 2026-07-07. Blank Transfers_Sub_Status__c is
    // treated as the start (Not Received).
    subStatusFlow: ["Not Received", "Transfers Received", "Transfers Cut/Ready"],

    // Roll-up CONFIRMED 2026-07-07 and OWNED BY A SALESFORCE FLOW (statusViaFlow:
    // true) — kept here for reference only; the endpoint does NOT write Status__c
    // for transfers. The flow applies: Not Received => Not Started, Transfers
    // Received => In Progress, Transfers Cut/Ready => Ready (drops off the board).
    statusMap: {
      "Not Received": "Not Started",
      "Transfers Received": "In Progress",
      "Transfers Cut/Ready": "Ready",
    },

    doneStatus: "Ready",
  },
};
