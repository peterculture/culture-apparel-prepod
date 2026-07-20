# Culture Apparel — Redesigned dashboards (drop-in for the Pages repo)

These are self-contained static pages that replace/augment the HTML in your
`culture-apparel-prepod` Cloudflare Pages repo. They talk to your **existing**
`functions/api/*` proxy over same-origin `fetch` — no backend changes.

## Files in this folder

| File | Purpose | Repo placement |
|------|---------|----------------|
| `index.html` | Production Dashboard (kanban: Ready for Print → In Production → Post-Production → Completed) | repo root (replaces old `index.html`) |
| `pre-production.html` | Pre-Production board (Screen Print / Embroidery / Heat Press) | repo root (replaces old) |
| `station.html` | Station tablet board (Ink / Blue Lagoon / Transfer / Garment) | repo root (replaces old) |
| `login.html` | PIN + name capture gate | repo root (new) |
| `order-sheet.html` | Printable order sheet (`order-sheet.html?orderId=<SF Id>`) | repo root (new) |
| `ca-api.js` | Shared API client — **required sibling**, fetched at runtime | repo root |

Keep your existing `functions/`, `wrangler.toml`, `tabler-icons.*`, and env
vars exactly as they are. Copy the six files above into the repo root, commit,
push — Pages redeploys.

> `ca-api.js` MUST sit at the site root next to the HTML: each page loads it with
> `import('./ca-api.js')` at runtime. Don't rename or move it.

## What's wired to your API (verified against `functions/api/*`)

- **Orders** — `GET /api/orders`, grouped by `Order_Substatus__c` (the
  "In Production" → stored value `Production` mapping is handled). Stage moves
  and Send-to-Production `PATCH /api/orders/:id` with `Order_Substatus__c`.
- **Pre-production checklists** → `Films_Printed__c`, `Screens_Completed__c`,
  `Mix_Inks__c`, `Digitize_File__c`, `Thread_Color_Materials__c`,
  `Transfers_Received__c`, `Transfers_Ready__c`.
- **Receiving** → `Receiving_Status__c`.
- **Misprints** → `TotalQtyMisprints__c`, `Misprint__c`, `Misprint_Details__c`.
- **Timers** → `Print_Setup_Timer__c`, `Production_Timer__c`.
- **Packaging** → `GET/POST /api/packaging` (`Order_Packaging__c`).
- **Shipments** → `GET/POST /api/shipments` (`zkmulti__MCShipment__c`).
- **Stations** → `GET /api/station-items`, `POST /api/update-item-status`,
  `POST /api/update-order-receiving`. Stage lists mirror `_station.js` exactly.
- **Inventory** → `GET/POST /api/inventory` (ink/screen).
- **Order sheet** → `GET /api/orders` + `GET /api/order-sizes`.
- Every write stamps `Last_Updated_By__c` from the logged-in name.

## Decisions applied (per your instructions)

- **Print method** is inferred from `Printer__r.Name` (screen / embroidery /
  heat-press keywords), falling back to whichever pre-prod fields are set.
  Tune the keyword list in `methodOf()` in `ca-api.js` if needed.
- **Timers** are stored as canonical **seconds** and displayed adaptively as a
  normal running clock — `SS`/`M:SS`/`H:MM:SS` depending on elapsed time.
- **Specifications for Printing** is left as the single `Specifications_for_Printing__c`
  field (used verbatim on the order sheet; not split).

## Identity / auth

`login.html` stores role + name in `localStorage` (`caShopRole`,
`caShopWorkerName`) — the same keys the boards read. This is the client-side PIN
only (worker `1234` / manager `6767`); it is **not** security. Keep
**Cloudflare Access** in front of the Pages project and `/api/*`, per your repo
README. The Station tablet uses `caStationWorkerName` and stays open-access.

## Offline note

Fonts (Oswald/Archivo) and Tabler icons load from a CDN, so the pages need
internet — same as any web app on the shop floor. Everything else is inlined.

## Demo vs. live

Each page shows **Live · Salesforce** (green) when `/api/orders` responds, or
**Demo data** (amber) with built-in sample orders when it can't reach the API
(e.g. opened as a local file before deploy). No action needed — it flips
automatically once served from Pages.
