/**
 * POST /api/station-login
 * Body: { "station": "ink", "pin": "1234" }
 *
 * Validates the station PIN server-side and, on success, sets an HttpOnly
 * signed-token cookie identifying the station. The PIN is checked against the
 * STATION_PINS env var (a JSON map, set in Cloudflare) -- never anything that
 * lives in the repo or ships to the browser.
 */
import { jsonError } from "../_sf.js";
import { signStationToken, stationCookie, safeEqual, STATION_CONFIG } from "../_station.js";

export async function onRequestPost({ env, request }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("invalid_body", 400);
    }
    const station = String(body.station || "").toLowerCase();
    const pin = String(body.pin || "");

    // Only stations that are actually configured can be logged into.
    if (!STATION_CONFIG[station]) return jsonError("unknown_station", 400);

    let pins = {};
    try {
      pins = JSON.parse(env.STATION_PINS || "{}");
    } catch {
      console.error("STATION_PINS is not valid JSON");
      return jsonError("server_misconfigured", 500);
    }

    const expected = pins[station];
    if (!expected || !safeEqual(pin, String(expected))) {
      return jsonError("invalid_pin", 401);
    }

    const token = await signStationToken(env, station);
    return new Response(JSON.stringify({ ok: true, station }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": stationCookie(token),
      },
    });
  } catch (err) {
    console.error(err);
    return jsonError("internal_error", 500);
  }
}
