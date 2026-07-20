# Culture Apparel — Redesigned dashboards (drop-in for the Pages repo)

Self-contained static pages that replace/augment the HTML in your
`culture-apparel-prepod` Cloudflare Pages repo. They call your **existing**
`functions/api/*` proxy over same-origin `fetch` — no backend changes.

## IMPORTANT — re-upload if you deployed the earlier build
These pages are now **fully self-contained**: the API client is embedded
directly inside each HTML file. There is **no separate `ca-api.js` to upload**
anymore. If you uploaded an earlier build, replace the five HTML files below and
you can delete any `ca-api.js` you added — it's no longer referenced.

## Files → repo placement (all at repo root, next to `functions/`)

| File | Purpose | Action |
|------|---------|--------|
| `index.html` | Production Dashboard (kanban) | replace existing |
| `pre-production.html` | Pre-Production board | replace existing |
| `station.html` | Station tablet board | replace existing |
| `login.html` | PIN + name capture gate | new |
| `order-sheet.html` | Printable order sheet (`order-sheet.html?orderId=<SF Id>`) | new |

Keep `functions/`, `wrangler.toml`, env vars, and secrets exactly as they are.
Commit + push these five files; Pages redeploys.

## How the live link works
On load each page calls `GET /api/orders` (and the other routes as you use the
screens). When that responds, the header badge shows **Live · Salesforce**
(green) and real records fill the board. If the call fails it shows **Demo data**
(amber) and uses built-in sample orders — so the page never renders blank.

If you still see **Demo data** after deploying:
1. Open the page, DevTools → **Network**, reload, and look at `/api/orders`.
   - **200** with records → you're live (hard-refresh; the badge follows the data).
   - **401 / 500** → the Function can't reach Salesforce: check the Pages env
     vars `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` (and that the
     External Client App's Client-Credentials "Run As" user has API access).
   - **404** → the `functions/` folder isn't deployed at the project root.
2. DevTools → **Console** for any red errors on load.

The same `/api/orders` powers your original pages, so if the old dashboard
showed real data, these will too once the five files are in place.

## Endpoints used (verified against `functions/api/*`)
`/api/orders` (GET + PATCH `:id`), `/api/order-sizes`, `/api/packaging` (GET/POST),
`/api/shipments` (GET/POST), `/api/station-items`, `/api/update-item-status`,
`/api/update-order-receiving`, `/api/inventory` (GET/POST), `/api/station-login`.
Every write stamps `Last_Updated_By__c` from the logged-in name.

Field mapping highlights: `Order_Substatus__c` (with the "In Production" →
stored `Production` value handled), `Receiving_Status__c`, the pre-prod booleans
(`Films_Printed__c`, `Screens_Completed__c`, `Mix_Inks__c`, `Digitize_File__c`,
`Thread_Color_Materials__c`, `Transfers_Received__c`, `Transfers_Ready__c`),
`TotalQtyMisprints__c`/`Misprint__c`/`Misprint_Details__c`,
`Print_Setup_Timer__c`/`Production_Timer__c`, Station stage lists from
`_station.js`, and `Order_Packaging__c` / `zkmulti__MCShipment__c`.

## Decisions applied
- **Print method** inferred from `Printer__r.Name` (screen / embroidery / heat
  keywords). To change the keywords, edit `methodOf()` — it's the inline
  `window.CAApi` block near the top of each HTML file (search `function methodOf`).
- **Timers** stored as canonical **seconds**, displayed adaptively (`SS`/`M:SS`/`H:MM:SS`).
- **Specifications for Printing** left as the single `Specifications_for_Printing__c` field.

## Auth & offline
`login.html` stores role + name in `localStorage` (`caShopRole`,
`caShopWorkerName`) — client-side PIN only (worker `1234` / manager `6767`), not
security. Keep **Cloudflare Access** in front of the project and `/api/*` per
your repo README. Fonts + Tabler icons load from a CDN, so the pages need
internet (same as any web app).
