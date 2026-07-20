# Culture Apparel — Redesigned dashboards (drop-in for the Pages repo)

Static pages that replace/augment the HTML in your `culture-apparel-prepod`
Cloudflare Pages repo. They call your **existing** `functions/api/*` proxy over
same-origin `fetch` — no backend changes.

## This build removes the loading splash
Earlier files were single self-contained bundles that showed a brief unpack
splash (the "CA" box) on every navigation. These are **plain pages** instead:
each HTML loads a shared `support.js` runtime — no unpack, no splash. That means
two small shared files ship alongside the HTML.

## Files → all at repo root, next to `functions/`

| File | Purpose | Action |
|------|---------|--------|
| `index.html` | Production Dashboard (kanban) | replace existing |
| `pre-production.html` | Pre-Production board | replace existing |
| `station.html` | Station tablet board | replace existing |
| `login.html` | PIN + name capture gate | new |
| `order-sheet.html` | Printable order sheet (`order-sheet.html?orderId=<SF Id>`) | new |
| `support.js` | shared UI runtime — **required by all pages** | new |
| `ca-api.js` | Salesforce API client — **required by index / pre-production / station / order-sheet** | new |
| `doc-page.js` | print helper — **required by `order-sheet.html`** | new |

Upload all eight to the repo root. Keep `functions/`, `wrangler.toml`, env vars
and secrets as-is. Commit + push; Pages redeploys.

> `support.js` and `ca-api.js` must sit at the site root next to the HTML (each
> page loads `./support.js` and `./ca-api.js` from its `<head>`). If a page
> renders blank, `support.js` is missing; if it's stuck on **Demo data**,
> `ca-api.js` is missing or the API isn't responding (see below).

## Live link / troubleshooting
On load each page calls `GET /api/orders`; the header badge shows
**Live · Salesforce** (green) when it responds, or **Demo data** (amber) with
sample orders if it can't reach the API. If you still see Demo data after
deploy, open DevTools → Network → reload → check `/api/orders`:
- **200 + records** → live (hard-refresh).
- **401 / 500** → Function can't reach Salesforce; check `SF_LOGIN_URL`,
  `SF_CLIENT_ID`, `SF_CLIENT_SECRET` and the Client-Credentials "Run As" user.
- **404** → `functions/` isn't deployed at the project root.

## Notes on this update
- **Assignee / Coordinator picker removed** from the order drawers (it showed
  placeholder names). The small avatar on a card still reflects the real
  `Last_Updated_By__c` when present — pure attribution, no assignment action.
- **Print method** inferred from `Printer__r.Name`; edit `methodOf()` in
  `ca-api.js` to tune the keywords.
- **Timers** stored as seconds, shown adaptively (`SS`/`M:SS`/`H:MM:SS`).
- **Specifications for Printing** left as the single field.

## Order tracking / stage placement
Fixed: `functions/api/orders/index.js` in this folder changes the query from
`WHERE Status = 'Pre-Production'` to `WHERE Order_Substatus__c != null`, so
orders whose standard `Status` has moved on (e.g. one sitting at substatus
**Post-Production**) still return and land in the right column. **Overwrite your
repo's `functions/api/orders/index.js` with the one in `functions/api/orders/`
here.** If your org's field API name isn't `Order_Substatus__c`, change that one
identifier in the `WHERE` clause.

## Auth & offline
`login.html` stores role + name in `localStorage` (`caShopRole`,
`caShopWorkerName`) — client-side PIN only (worker `1234` / manager `6767`), not
security. Keep **Cloudflare Access** in front of the project and `/api/*`. Fonts
+ Tabler icons load from a CDN, so the pages need internet.
