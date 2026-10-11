# Timmy Cloud: the backend, slice 1

Round R4, helper H91, branch `r4/cloud-1`. **Status: implemented and tested in the development container, against a
SIMULATED provider only.** No real provider was called, no account was read, nothing was bought or registered, no DNS
changed, nothing was deployed or deleted anywhere real. Live-qualified: nothing. The order this slice follows, its limits
and the capability matrix are in [CONNECT-AND-CLOUD.md](CONNECT-AND-CLOUD.md).

Timmy Cloud is hosting for Timmy Pro customers (websites, domains, VPS), bought and run through the operator's Hostinger
agency arrangement. The agency credentials live only in a backend the operator runs; customers and their Timmy never hold
them. This slice is that backend's provider-neutral core: who a customer is and what they may spend, orders as durable
steps, write-ahead provider calls with reconcile, cancellation said exactly, retention when Pro is cancelled, and the
operator's overview. A private Hostinger adapter exists outside this repository; it stays private and was not looked at.

## Where it lives

`services/cloud/`, outside `src/`: `src/` ships in the npm package, and this backend must never reach a customer's
machine. Nothing under `services/` is in the package's `files` list. It has its own `tsconfig.json` (extending the root
one; it also type-checks `tests/cloud-*.test.ts`).

| File | What it is |
|---|---|
| `types.ts` | the model: customers, limits, orders and their steps, resources, retention items, deletions, events |
| `provider.ts` | the provider interface a provider adapter implements; what the provider does not offer |
| `reducer.ts` | the pure reducer: the state from the events; a duplicate event changes nothing |
| `event-log.ts` | the append-only JSON-lines log (fsync per event), cut lines, the one-writer lock |
| `engine.ts` | the rules: write ahead, reconcile, limits, approvals, cancellation, retention, deletion |
| `views.ts` | what customers and the operator are shown: each order's words, the overview |
| `http.ts` | the HTTP API (node:http, 127.0.0.1) |
| `redaction.ts` | the agency credential (environment or a 0600 file), redaction, token hashes |
| `simulated-provider.ts` | the SIMULATED provider: an in-memory HTTP server with scripted outcomes and faults |
| `simulated-adapter.ts` | the adapter for the simulated provider, over HTTP |
| `simulated-main.ts` | the simulated provider as a process of its own, for trying the backend by hand |
| `failpoints.ts` | a test hook that kills the backend's own process at a named point (off unless set) |
| `main.ts` | the process: `node --import tsx services/cloud/main.ts --data <folder> --provider-url <url>` |
| `test-support.ts` | helpers for the tests (not part of the backend) |

## The model

**A customer** has an id (`cus_…`), a token (stored only as its sha256), the Timmy Pro subscription's state as billing
gives it (`active`, `past_due`, `canceled`; there is no payment processor here), and limits in cents: a per-order cap, a
monthly cap (counted at approval, per calendar month in UTC) and an automatic-approval threshold that defaults to 0. Both
caps are required whole numbers: there is no "unlimited", so a Pro subscription never authorizes unlimited purchases.

**An order** belongs to one customer and asks for one thing: a `domain` (registered), a `vps`, or a `site` on the
operator's agency plan (set up, not bought), optionally linked to one of the customer's own registered domains. One order
per (customer, Idempotency-Key): the same request again returns the same order; a different request under a used key is
refused and nothing is created.

**Every order is eight steps, each with its own state, time and words**, never one word for the whole order:

| Step | States | What it is |
|---|---|---|
| quote | pending, quoted, failed | the price from the provider's catalog, with its source and time |
| approval | not_started, waiting, approved, refused, cancelled, stopped | automatic only at or under the customer's threshold and inside both limits; otherwise the operator's; refused by rule when a limit or the subscription forbids it |
| payment | not_started, in_flight, pending, paid, failed, unknown, not_needed, cancelled, stopped | pending: the provider answered "still processing" (202 at the documented provider); not_needed: a site costs nothing |
| acceptance | not_started, in_flight, accepted, refused, unknown, cancelled, stopped | the provider took the order or the setup and gave its reference |
| provisioning | not_started, in_flight, pending, completed, failed, unknown, cancelled, stopped | the registration, the site setup (a setup id read until it gives a site id), the VPS setup |
| dns | not_started, in_flight, completed, failed, unknown, not_needed, cancelled, stopped | linking the customer's domain to the site |
| certificate | not_started, in_flight, pending, active, failed, unknown, not_needed, cancelled, stopped | a certificate for the linked domain |
| health | not_started, ok, failing, not_needed, cancelled, stopped | the site answers; the VPS runs |

`in_flight`: a call was written ahead and its answer has not come back. `unknown`: the answer was lost (a timeout, a reset
connection, a 5xx, the backend stopped during the call): the provider may or may not have acted. `cancelled`: cancelled
here before anything was sent. `stopped`: will not run, because an earlier step ended the order or a person stopped it;
its words say which. Each order also carries a sentence naming the steps that matter now, whether it is `partial`
(something was made and a later step failed), what needs a person and the next action. A cost is a number the catalog or
the provider reported, `null` when a purchase went out and no amount came back, and absent when no purchase went out.

**A resource** (`res_…`: a site, a domain, a VPS, a certificate) belongs to the customer whose order made it; it is
`active`, `retained`, `deleting` or `deleted`. A failed payment creates none.

## The rules

**Write ahead, then reconcile.** Before any provider call that changes something, the backend writes a `call.intent`
event and fsyncs it; the answer is written after, with everything it changes in the same event. A call whose answer is
lost leaves its steps `unknown`, never `failed`, never sent again blindly. When a backend starts, every call the previous
process left out (written ahead, never answered) becomes `unknown` with these words: "the backend stopped while this call
was out (a crash or a local stop). Stopping the backend cancels nothing at the provider: it may have acted."
Reconcile reads the provider, by the reference it returned or by what the call asked for:

- found: the step moves on exactly as the answer would have moved it;
- proven not to have happened: the step is `not_started` again and the call may be sent again (once);
- neither: the step stays `unknown` and the order waits for a person, with what is known. **A purchase whose outcome is
  unknown is never sent again until reconcile proves it did not happen, or a person says so.**

What a lookup can prove depends on the provider. The documented provider's purchase takes no client reference (items,
a payment method, coupons), so a lost purchase can be found by what it bought (a domain by its name) but never proven
absent: a domain not yet in the account may be an order whose payment is still processing. A VPS purchase cannot even be
matched with certainty (a new subscription with the item's name may be someone else's), so it always waits for a person,
with the candidates named. A domain link, a certificate, a domain's registration, a VPS setup and a site deletion are read
directly and can be proven either way. The simulated provider can be started as a provider that keeps client references
(`provesAbsence`), so both paths are tested.

**Events.** Every change is one JSON line in `<data>/events.jsonl` (0600, in a 0700 folder), fsynced before the backend
acts on it; nothing in the file is rewritten or removed. The state is rebuilt from the log at every start by a pure
reducer (`rebuild(events)`; same events, same state). A duplicate event (the same id: a billing or provider notice
delivered twice, a line written twice) changes nothing. A last line cut short by a crash is reported and never applied; it
is marked when the log is next opened, so it can never be read as an event later. After a failed write the log refuses
further writes until a restart. One backend at a time: the folder's lock names its process, and a lock left by a process
that is gone is taken over.

**Limits and approval.** Every order is quoted from the provider's catalog, then: refused by rule if the subscription is
not active, the quote is not in USD, or it passes the per-order or the monthly limit; approved automatically if the
threshold is above 0 and the quote is at or under it; otherwise it waits for the operator, whose approval checks the
limits again. No purchase is sent while the subscription is `past_due` or `canceled`, and no new order is taken.

**Cancellation.** Before submission (before any call that changes something was written ahead), the order is cancelled
here and nothing is sent. After it, the backend records "cancel asked" and says exactly: *the provider has no operation
that cancels a purchase or a setup, so the provider operation was NOT cancelled*; the order makes no new call that changes
anything, is still reconciled, and once nothing is pending a person decides to go on or stop. A local stop (the backend
killed or stopped during a call) cancels nothing at the provider, and the order says so.

**Failed payments and partial provisioning.** A payment the provider reports failed ends the order: `payment: failed` with
the provider's own words, every later step `stopped`, no resource. A site whose domain link or certificate failed is
partial: the site resource exists, each step keeps its state, and the next action is named (make the domain point to the
site, then retry the link; or fix the cause and retry the certificate, within the provider's three certificate setups per
domain per seven days).

**Pro cancelled.** When billing says `canceled`: no new orders; every resource of the customer becomes `retained` (nothing
deleted, no provider delete call) with a retention date (`--retention-days`, 30 by default); the operator gets an item to
export each site and VPS, and an item to decide each domain: transfer it to the customer, renew it, or let it lapse on its
date. The backend never lets a domain lapse without a person's decision, and says when one expired undecided. A resource
that appears after the cancellation (a purchase already submitted settles later) is retained the same way. Deletion is a
separate request a person approves, naming the resource again; a site's deletion is refused while its export is open.
Billing saying `active` again ends the retention.

**The agency credential** comes only from `TIMMY_CLOUD_AGENCY_TOKEN` (removed from the environment once read) or a secret
file named with `--agency-token-file`, which must be readable by its owner only (0600 or 0400; a looser file, a symbolic
link, two sources or none are refused, in words with no path and no value, and nothing starts). It is sent only in the
provider's Authorization header. Every event, response and log line passes a redactor that replaces it in every form (as
is, JSON-escaped, URL-encoded, base64, as a Bearer header), including inside a provider error that echoes it. Customer
tokens are kept as sha256 hashes; the operator's token is given to the backend only as its sha256
(`--operator-token-sha256` or `TIMMY_CLOUD_OPERATOR_TOKEN_SHA256`).

## What a person decides

| Decision | Route (operator) |
|---|---|
| Approve an order waiting for the operator (the limits are checked again) | `POST /v1/operator/orders/:id/approve` |
| What happened to a call reconcile could not settle: `happened` (with the provider's reference) or `did_not_happen` | `POST /v1/operator/orders/:id/resolve` |
| An order the customer asked to cancel after submission: `continue` or `stop` (stop keeps what exists) | same |
| Retry a step the provider failed: a site's provisioning, its domain link, its certificate, a health check | same, with `action: "retry"` |
| After Pro is cancelled: each export done (`exported`); each domain `transfer_to_customer`, `renew` or `let_lapse` | `POST /v1/operator/retention/:id/decide` |
| A deletion: asked for, then approved (naming the resource again) or refused | `POST /v1/operator/deletions`, `POST /v1/operator/deletions/:id/decide` |
| A customer and their limits; the subscription's state, as billing gives it | `POST /v1/operator/customers`, `PUT /v1/operator/customers/:id/limits`, `POST /v1/operator/billing-notices` |

Every decision carries a note in words and is kept on the order (`decisions`) or its item.

## The HTTP API

Customer routes take a customer's token (`Authorization: Bearer …`) and see only that customer's orders and resources;
another customer's id answers exactly as a missing one does (the same status and the same bytes). Operator routes take
the operator's token. Every answer is JSON; an error is a sentence, never a path or a stack. The backend listens on
127.0.0.1 only, refuses another Host header and any request from a web page (an Origin header).

| Route | Who | What |
|---|---|---|
| `GET /v1/resources` | customer | the customer's resources |
| `GET /v1/orders` | customer | the customer's orders |
| `POST /v1/orders` (header `Idempotency-Key`) | customer | `{kind, item_id, domain}`; 201 created, 200 the same order again, 409 the key with another request |
| `GET /v1/orders/:id` | customer | one order |
| `POST /v1/orders/:id/cancel` | customer | cancelled here (before submission) or "cancel asked" (after) |
| `GET /v1/operator/overview` | operator | below |
| `GET /v1/operator/orders/:id` | operator | any order |
| `POST /v1/operator/orders/:id/approve`, `…/reconcile`, `…/resolve` | operator | above |
| `POST /v1/operator/reconcile` | operator | reads the provider for everything unfinished |
| `POST /v1/operator/provider-notices` | operator | `{notice_id, reference}`: the orders holding the reference are reconciled by reading the provider; the notice itself moves nothing |

**The overview** (`GET /v1/operator/overview`, which God's Eye View reads later): for each step, the number of orders in
each of its states (zeros included); per customer, the subscription, the limits, what was approved and paid this month
and how many orders have an unknown cost; the deletions by state; and `needs_person`: each item with its kind (approval,
unknown_outcome, cancel_asked, stopped_mid_order, purchase_blocked, subscription_canceled, failed_step, export,
domain_decision, deletion_approval, deletion_unknown, event_log), the customer, the order or item, since when, the reason
and the next action. It also names the provider (and that it is simulated), what its lookups can prove, the rate-limit
pause, and the event log's unreadable lines.

## Simulated, and not

| | In this slice |
|---|---|
| The provider | **simulated** (`simulated-provider.ts`): an HTTP server on 127.0.0.1 holding everything in memory; its catalog's prices are simulated and are no provider's real prices |
| What the simulated provider models (from the official Hostinger MCP server 2.11.0's README and the Hostinger CLI's documentation, read as files) | a purchase with no payment method uses the account's default one; 202 means the payment is still processing (a domain bought that way is registered only after its setup is completed); an order can end failed; a site setup answers a setup id, read until completed (then a site id); deploying an archive overwrites a site and cannot be undone; deleting a site is immediate; certificate setups are limited (three per domain per seven days; again within a minute is a 429); no operation cancels a purchase or a setup, shares access or makes a sub-account; a shared rate limit (429 with Retry-After) |
| What differs from the documented provider | neutral paths of its own; a VPS setup keyed by the order's reference (the documented provider sets a purchased VM in `initial` state up by the VM's id, or sets it up in the purchase call itself); outcomes and faults scripted by the tests |
| The backend, its log, its HTTP API, its rules | real code, run for real here: real files, real HTTP, real child processes killed for real |
| Payments, billing | there is no payment processor: the subscription's state is what billing notices say; the provider's payments are simulated |
| Deployment of anything | **on HOLD**: the interface names `deploy_archive` (irreversible); the backend has no route that calls it |

## What a provider adapter must implement

`CloudProvider` in `provider.ts`, never throwing for a provider's answer:

- `info`: its name, whether it is simulated, and what its purchase lookups can prove (`client_reference` or `none`);
- `call(call)` for each `ProviderCall` (`purchase`, `complete_domain_registration`, `start_site_setup`, `link_domain`,
  `start_certificate`, `start_vps_setup`, `delete_site`, `deploy_archive`), each carrying the backend's call id as its
  client reference, ending in a `CallOutcome`: answered, refused (a 4xx: it did nothing), rate_limited (429 with its
  Retry-After), busy (409 with Retry-After), not_sent (the connection was refused before a byte was written), unknown
  (the answer was lost or unreadable, or a 5xx: it may have acted);
- `read(read)` by the provider's own references (the catalog, a purchase, a domain, a setup, a site, a certificate, a
  site's health, a VPS);
- `findEffect(call, since)`: did this call take effect? `found` with what it did, `proven: true` only when the provider's
  own records show it did not, else `proven: false` with what was seen;
- never invent an operation the provider does not have (`OPERATIONS_THAT_DO_NOT_EXIST`): no cancel, no shared access, no
  sub-accounts; treat `IRREVERSIBLE_OPS` (delete, deploy) as such; keep the credential out of every word it returns.

## Live steps that need the operator's approval (a plan only: none was run)

Each would come to the operator as its own request, with its exact calls; nothing below is authorized by this slice.
Costs are the provider's catalog prices at the time of the quote, which are not known here (the simulated catalog's are
not the provider's).

| Step | Cost | What it changes | Recovery the provider offers |
|---|---|---|---|
| Give the backend a read-only view of the account (catalog, orders, subscriptions, domains, agency websites) | none (counts against the shared rate limit) | nothing | revoke the token |
| Run this backend where the operator chooses, with the agency token in its secret store | the host's own cost | a new private service | stop it; revoke the token |
| Register a domain for a customer | the catalog's price, charged to the account's default payment method | a new domain and subscription in the account | no API cancels a purchase; the provider's support, under its terms; auto-renewal can be turned off |
| Buy a VPS | the catalog's price per period | a new VM and subscription | no API cancels it; snapshots and backups exist for its data, not for the purchase; auto-renewal can be turned off |
| Set up a site on the agency plan | no purchase (the plan's capacity) | a new website | delete it (immediate, irreversible) |
| Link a domain, install a certificate | none | the domain serves the site; a certificate (three setups per domain per seven days) | unlink (the site stops serving that domain at once); remove the certificate |
| Change DNS | none | the zone's records | the provider keeps DNS snapshots that can be restored, and a reset to its defaults |
| Deploy an archive to a site | none | **overwrites the site's contents; cannot be undone** | none at the API: keep the previous archive first |
| Delete a site | none | **immediate and irreversible** | none |
| Transfer a domain to a customer, renew it, or let it lapse | renewal: the catalog's renewal price; transfer: the receiving registrar's fee | the domain's owner or its end date | a renewal cannot be undone at the API; a transfer is started with the domain's authorization code (requesting a new code invalidates the previous one) |

## Tests

All run here against the simulated provider: `tests/cloud-api.test.ts` (ownership on every customer route, the operator's
credential, duplicate requests and notices, limits, cancellation, failed payments, partial provisioning, Pro cancelled,
deletion, the overview's counts against the orders' own states, hashes in the log and a rebuild after a restart),
`tests/cloud-reconcile.test.ts` (answers lost by a reset, a timeout and a 5xx; requests that never arrived, with and
without client references; a VPS that waits for a person; links and setups settled by reading; the rate limit's
Retry-After, also across a restart; the planted credential), `tests/cloud-crash.test.ts` (real backend processes killed
with SIGKILL before and half way through each of an order's writes, after a call was written ahead, after it was
answered; SIGKILL and SIGTERM during a provider call; one backend per folder), `tests/cloud-redaction.test.ts` (start
refusals and a planted credential, in a real process), `tests/cloud-process.test.ts` (the two processes started as below,
one order) and `tests/cloud-model.test.ts` (the reducer, cut lines, the simulated provider's modelled behaviours,
redaction, tokens). Type checks: `npx tsc --noEmit -p services/cloud` and
`npx tsc --noEmit -p .`.

## Trying it by hand (simulated only)

From a clone at this branch, with a made-up credential that the simulated provider and the backend share (never a real
one), and an operator token given to the backend only as its sha256:

```sh
export TIMMY_CLOUD_AGENCY_TOKEN="sim-$(openssl rand -hex 24)"
OPERATOR_TOKEN="tc_$(openssl rand -hex 32)"
OPERATOR_SHA=$(printf %s "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1)
node --import tsx services/cloud/simulated-main.ts --port 8790 &
node --import tsx services/cloud/main.ts --data "$(mktemp -d)/cloud" --provider-url http://127.0.0.1:8790 \
  --operator-token-sha256 "$OPERATOR_SHA" --port 8791 &
curl -s -X POST http://127.0.0.1:8791/v1/operator/customers -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' -d '{"limits":{"per_order_cents":5000,"monthly_cents":9000},"subscription":"active"}'
```

The answer carries the customer's token once. Then `POST /v1/orders` with that token and an `Idempotency-Key` header
(`{"kind":"domain","item_id":"sim-domain-com-1y","domain":"by-hand.example"}`), `POST
/v1/operator/orders/<id>/approve` with the operator's token, and `GET /v1/operator/overview`. Both processes stop on
SIGTERM; the data folder holds `events.jsonl` and `backend.log`.

## Open

- God's Eye View does not read the overview yet (its slice 2).
- No real adapter here; the private one would implement `CloudProvider`, and its `findEffect` must say honestly what it
  can prove (per the documentation: purchases `none`).
- Customer token rotation, more than one operator, and billing notices arriving out of order are not built.
- Every 429 is treated as the shared limit (the documented certificate 429 too): the whole backend waits, which is safe
  and can be slower than needed.
- A failed append (a full disk) is handled by refusing further writes until a restart; that path has no test here.
- The backend binds 127.0.0.1 only; serving customers over a network is a deployment decision, on HOLD.
