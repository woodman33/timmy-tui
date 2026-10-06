# Timmy Pro

**$19 / month. One plan.** Free Timmy stays fully local; Pro adds hosted services
that run on Timmy's servers, and you opt in to each one.

| Pro feature | Status |
|---|---|
| Cloud Logs dashboard (opt-in sync of runs and receipts) | next PR |
| Shareable verify links for single receipts | next PR |
| Verified release receipts and Pro badge | planned |
| Hosted agent runs | planned |

This page covers **billing and licensing**, which ship first: Stripe Checkout,
license keys, and signed license tokens. The `timmy pro` CLI commands come in the
next PR.

## How buying works

1. `timmy pro upgrade` (next PR) or the **Upgrade** button on the landing page opens Stripe Checkout.
2. After payment, the CLI receives the key automatically. The browser's welcome page also shows it.
3. `timmy pro activate <key>` exchanges the key for a **license token**: an ed25519-signed
   claim (the same signature family as receipts) that the CLI verifies offline for up to 7 days.

**Keys**
- Shown once, for 24 hours, on the welcome page and to the CLI. After that the checkout
  link reveals nothing.
- `timmy pro rotate` replaces a leaked key; the old one stops working at once.
- Lost a key? Reply to the Stripe receipt email.

**Billing** (`timmy pro billing`) opens Stripe's own customer portal, where the customer
signs in by email. A license key alone never opens the portal.

**Enforcement.** Hosted Pro features check the key on the server. The local token only
decides what the TUI offers, so editing a local file cannot unlock anything hosted.

## Architecture

```
CLI / browser ──► Worker (workers/pro) ── per-IP rate limit ──► Durable Object "ledger" (SQLite)
                                                                    │
                                     src/pro/service.ts ◄───────────┘  (all logic; tested in tests/pro-*.test.ts)
                                            │
                                    Stripe REST API (src/pro/stripe-api.ts)
```

| Route | Purpose |
|---|---|
| `GET /` | Landing page with the Upgrade button |
| `POST /checkout` | Creates the Stripe Checkout Session (JSON for the CLI, 303 for the web form) |
| `GET /welcome?session_id=` | Shows the key (first 24 hours only) |
| `POST /license/claim` | The CLI polls this after checkout (same 24-hour window) |
| `POST /license/activate` | Key → signed license token |
| `POST /license/rotate` | Key → new key; the old one is revoked |
| `GET` / `POST /billing` | Stripe customer-portal login link |
| `POST /stripe/webhook` | Signature-checked events keep subscription status current |

### Security model

Each rule below has a test, and a negative control (break the rule → a test fails).

- **Webhooks:** HMAC-SHA256 over the raw body, ±300 s tolerance, constant-time compare, deduped by event id.
- **Status:** always read fresh from Stripe inside a per-subscription lock, never taken from the event payload,
  so out-of-order or concurrent events cannot leave a canceled plan active.
- **What counts as a purchase:** only a subscription to the Timmy Pro price (lookup key `timmy_pro_monthly`).
  Any other subscription on the same Stripe account is ignored. Promotion codes are off.
- **Tokens:** issued only while the plan is active or trialing. A `past_due` plan keeps Pro for 14 days, then stops.
  The verifier also rejects any token whose status is not active.
- **Key storage:** keys are derived (HMAC) from the subscription id and a version number; only their SHA-256 is stored.
- **Rate limits and errors:** 20 requests per minute per IP on Stripe-backed routes. Errors are generic: Stripe's
  messages and configuration details stay in the Worker logs.

## Test mode (no real money)

1. Create the product and price, once:
   `node scripts/pro/stripe-setup.mjs`
   This uses the logged-in Stripe CLI, in test mode.
2. Generate the signing key and key secret:
   `node scripts/pro/gen-license-keys.mjs`
   This writes a 0600 file under `.timmy/private/` and prints only the public key.
3. Create `workers/pro/.dev.vars` (gitignored). It needs:
   - `STRIPE_SECRET_KEY=sk_test_…`
   - the two `LICENSE_*` values from step 2
   - `STRIPE_PORTAL_LOGIN_URL`
4. Run the worker: `cd workers/pro && npm run dev` (port 8787).
5. Forward webhooks: `npm run stripe:listen`. Copy the printed `whsec_…` into `.dev.vars` as
   `STRIPE_WEBHOOK_SECRET` and restart `npm run dev`.
6. Buy: `curl -s -XPOST localhost:8787/checkout -H 'content-type: application/json' -d '{"source":"cli"}'`.
   Open the URL and pay with card `4242 4242 4242 4242`. The welcome page shows the key.
7. Cancel from the Stripe dashboard (test mode), or run `stripe trigger customer.subscription.deleted`.
   `POST /license/activate` with the key now returns 403.

## Going live (owner)

1. `node scripts/pro/stripe-setup.mjs --live --confirm-live` creates the live $19/month price.
2. In the Stripe Dashboard:
   - Billing → Customer portal → enable the **login link**. Set it as `STRIPE_PORTAL_LOGIN_URL`.
   - Developers → Webhooks → add `https://<pro host>/stripe/webhook` with these events:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`
   - Settings → Subscriptions → after all retries fail, **cancel** the subscription.
3. Set the secrets in `workers/pro`, each with `npx wrangler@4 secret put`:
   - `STRIPE_SECRET_KEY` (live)
   - `STRIPE_WEBHOOK_SECRET`
   - `LICENSE_SIGNING_KEY`
   - `LICENSE_KEY_SECRET`
4. Deploy: `npm run deploy`. Then put the public key from step 2 of test mode into the CLI build.

## The older billing scaffold

`src/companion/cloudflare-worker.ts` (the `timmy-ai-proxy` scaffold) had its own Stripe routes. They are now
hardened:
- its webhook requires Stripe's signature, handles only paid checkouts, and never downgrades;
- `/success` no longer grants a tier from the URL, except in local demo mode (`BILLING_MOCK=1` with no Stripe key);
- user ids are filtered before they reach HTML;
- Stripe errors no longer reach callers.

Timmy Pro does not use those routes. Retiring them is a separate decision.
