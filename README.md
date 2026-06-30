# Culture Apparel Pre-Production — Cloudflare Pages deployment

This turns the dashboard from a Salesforce Visualforce page into a live web app
hosted on **Cloudflare Pages**, deployed from GitHub. The static HTML is served
at the edge; a small **Pages Function** acts as a backend proxy to Salesforce so
the browser never has to do OAuth (which is what the CORS wall blocked before).

```
Browser (static HTML)
   |  fetch('/api/orders')                     <- same origin, no CORS
   v
Cloudflare Pages Function (functions/api/...)
   |  1. client_credentials -> Salesforce token endpoint   <- server-side, no CORS
   |  2. REST query / update with bearer token
   v
Salesforce dev2 sandbox
```

> Note: For brand-new projects in 2026, Cloudflare now nudges people toward
> "Workers with static assets" rather than Pages. Pages is fully supported and
> is the simpler git-push option for a static-first app like this, so it's used
> here. Pages Functions are Workers under the hood, so the proxy code is the same
> either way if you ever migrate.

---

## Repo layout

```
.
├── index.html                 <- your dashboard (rename from culture_apparel_*_SF.html)
├── functions/
│   └── api/
│       ├── _sf.js             <- shared Salesforce auth helper (not a public route)
│       └── orders/
│           ├── index.js       <- GET  /api/orders   (list Pre-Production orders)
│           └── [id].js        <- PATCH /api/orders/:id (update one order)
├── wrangler.toml              <- optional, for local dev
├── .dev.vars.example          <- copy to .dev.vars for local secrets (git-ignored)
└── .gitignore
```

Put your dashboard HTML at the repo root as **`index.html`**. Keep the
`functions/` folder at the root too — Cloudflare auto-detects it.

---

## Part 1 — Salesforce: create an app for server-to-server auth

The old Visualforce page authenticated automatically via the logged-in session.
A standalone web app can't do that, so you create an app that uses the
**OAuth 2.0 Client Credentials flow** (machine-to-machine, no user login).

> Heads up: as of Spring '26 Salesforce restricts creating new **Connected
> Apps** and recommends **External Client Apps (ECAs)** instead. Steps below use
> an ECA; if you have an existing Connected App you can reuse it the same way.

1. In your **dev2 sandbox**: Setup → search **App Manager** (or **External
   Client App Manager**) → **New External Client App**.
2. Enable **OAuth**. Set a callback URL (any value, e.g. `https://localhost/` —
   it isn't used by this flow).
3. OAuth scopes: add **Manage user data via APIs (api)**.
   Do **not** add `refresh_token` / `offline_access` — they're invalid for
   client credentials and cause auth errors.
4. Enable **Client Credentials Flow**, accept the security warning, save.
5. **Set a "Run As" execution user.** Manage → Edit Policies → Client
   Credentials Flow → Run As → pick a user. This user's permissions decide what
   the app can read/write, so it needs API access plus read/write on `Order` and
   all the pre-production fields. An "API Only" integration/service user is the
   recommended choice.
6. **Manage Consumer Details** → copy the **Consumer Key** (client_id) and
   **Consumer Secret** (client_secret). Keep these secret.
7. Note your **My Domain URL** for the sandbox, e.g.
   `https://YOURDOMAIN--dev2.sandbox.my.salesforce.com`. This is your
   `SF_LOGIN_URL`.

Activation can take up to ~10 minutes. Quick test from a terminal:

```bash
curl https://YOURDOMAIN--dev2.sandbox.my.salesforce.com/services/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id=YOUR_CONSUMER_KEY \
  -d client_secret=YOUR_CONSUMER_SECRET
```

A JSON response with `access_token` and `instance_url` means it works.

---

## Part 2 — Cloudflare Pages: deploy from GitHub

1. Push this repo (with your `index.html`) to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → pick the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: **(leave empty)**
   - Build output directory: **`/`** (root — that's where `index.html` lives)
4. **Add environment variables** (Settings → Variables and Secrets). Set these
   for the Production environment (and Preview if you use preview deploys):
   - `SF_LOGIN_URL` = `https://YOURDOMAIN--dev2.sandbox.my.salesforce.com`
   - `SF_CLIENT_ID` = your Consumer Key
   - `SF_CLIENT_SECRET` = your Consumer Secret  ← mark as **encrypted / secret**
   - `SF_API_VERSION` = `v60.0` (optional)
5. **Save and Deploy.** You get a `*.pages.dev` URL. Add a custom domain later
   under the project's Custom domains tab if you want.

Every push to your production branch redeploys; every other branch gets its own
preview URL.

---

## Part 3 — Point the dashboard's HTML at the proxy

In the current Visualforce build, the HTML reads `{!$Api.Session_ID}` and calls
Salesforce REST endpoints directly. Replace those with same-origin `/api` calls.

**Before (Visualforce):**
```js
const token = "{!$Api.Session_ID}";
const res = await fetch(
  "/services/data/v60.0/query/?q=" + encodeURIComponent(soql),
  { headers: { Authorization: "Bearer " + token } }
);
```

**After (Cloudflare):**
```js
// List Pre-Production orders
const res = await fetch("/api/orders");
const data = await res.json();          // same shape Salesforce returns: { records: [...] }

// Update one order (checkbox or receiving status)
await fetch(`/api/orders/${order.Id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ Films_Printed__c: true }),
  // or: body: JSON.stringify({ Receiving_Status__c: "Counted In" }),
});
```

Remove the `{!$Api.Session_ID}` reference and any hard-coded instance URL — the
Function owns all of that now. The response from `/api/orders` is the raw
Salesforce query payload, so your existing record-parsing code should keep
working unchanged.

---

## Part 4 — IMPORTANT: lock down access

Your old Visualforce page was protected by Salesforce login — only authenticated
org users could reach it. A public `*.pages.dev` URL has **no such protection**.
The in-app PIN (1234 / 6767) is client-side only and does **not** stop anyone
from calling `/api/orders` directly and reading or writing your real orders.

Before this is "live" for the shop, put real auth in front of it. Recommended:

- **Cloudflare Access (Zero Trust):** wrap the whole Pages project behind a login
  policy (email one-time PIN, Google Workspace, etc.). Free tier covers up to 50
  users. This is the cleanest fix and requires no code — Cloudflare dashboard →
  Zero Trust → Access → Applications → add your Pages domain → define who's
  allowed. The Functions are protected automatically because they're same-origin.

At minimum, restrict who can reach the site; don't rely on the PIN for security.

---

## Local development (optional)

```bash
npm install -g wrangler          # or: npx wrangler ...
cp .dev.vars.example .dev.vars   # fill in your real values (git-ignored)
npx wrangler pages dev .
```

This serves `index.html` and runs the Functions locally against your sandbox.

---

## Field-name checklist

The Function's SELECT and update allow-list use the API names from the project
notes. Verify each one against your org (Setup → Object Manager → Order →
Fields) and edit `functions/api/orders/index.js` / `[id].js` if any differ:

- `Receiving_Status__c`, `Films_Printed__c`, `Screens_Completed__c`,
  `Mix_Inks__c`, `Digitize_File__c`, `Thread_Color_Materials__c`,
  `Transfers_Received__c`, `Transfers_Ready__c`, `Print_Date__c`, `OrderNumber`
- `Name` on `Order` is flagged in the code — confirm what actually holds the
  customer name in your org and adjust if needed.
