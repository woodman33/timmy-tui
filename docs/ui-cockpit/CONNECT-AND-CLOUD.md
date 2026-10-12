# Timmy Connect and Timmy Cloud: capability matrix and slices

Status (2026-10-12, at `876755a`; the matrix below updated by helper H106 from TIMMY-CONNECT.md, TIMMY-CLOUD.md,
GODS-EYE-VIEW.md and the Mac rehearsal r24): the first slice of each is **implemented and tested**, Timmy Connect's
against FAKE OpenSSH programs and Timmy Cloud's against a SIMULATED provider. On the operator's Mac, r24 (at `a300851`)
ran Timmy Connect's real-OpenSSH test file against an sshd the test started on 127.0.0.1: that is the only live run so
far, and it reached no other computer. Nothing has been provisioned or bought, no provider account has been read, and no
computer's services have been changed. The private Hostinger adapter (outside this repository) is read only and its
account access is not validated. The whole capability matrix of Timmy is [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md).

## The owner's order (2026-10-10 19:38 PT), and the limits every slice keeps

Timmy Connect: Tailscale connectivity, SSH control and native Windows OpenSSH. Timmy Cloud: Hostinger-backed hosting for
Timmy Pro. In the owner's words:

> do not assume live provisioning or account access has been validated.
> Keep private operator configuration separate from distributable Timmy code.
> Do not put every customer into my personal unrestricted tailnet or assume experimental APIs support normal human onboarding.
> A working connection does not prove CAD, rendering, GPU acceleration or native application support.
> Do not invent a subaccount API.
> Preserve Timmy's two independently usable MCP-to-CLI routes.
> A Pro subscription must not silently authorize unlimited purchases against my account.
> Keep my agency credentials exclusively in the trusted backend/secret store. Never distribute them through npm, browser
> code, customer agents, prompts, logs or downloadable configuration.
> Cancelling Timmy Pro must not silently delete customer data or abandon domain ownership.
> Stopping a local command does not imply a provider-side purchase or provisioning operation was cancelled.
> Do not describe logging alone as self-learning.
> This authorizes development and isolated testing. Prepare concrete provisioning plans, costs and rollback/recovery
> details before requesting any additional authorization needed for live paid resources, production DNS, account access
> or machine service changes.

Tests the order names: cross-customer denial, duplicate events, interrupted connections, accurate cancellation, failed
payments and partial provisioning, secret redaction, native Windows/macOS/Linux where available, consistent UI state,
real artifact retrieval. At the owner's later direction (21:12 PT) this work started after the R4 batch closed (`0857031`),
and God's Eye View is extended rather than rebuilt.

## Capability matrix

Researched: read from official documentation or source, nothing run. Implemented: code on this branch. Simulated: run
against a stand-in (a FAKE program or a simulated provider). Tested: automated tests pass (the full suite at `5e5cbb3`
passed with the files named here). Live-qualified: run for real against the real computer or account, with the evidence
kept; "partial" says exactly what ran. A cell is – until a ledger row of CHECKPOINTS.md, or a Mac rehearsal's report, says
otherwise (r24 at `a300851`, helper H96's report to the lead: no ledger row yet). Connect's tests are
`tests/connect-ssh.test.ts`, `tests/connect-records.test.ts`, `tests/connect-windows.test.ts` and `tests/connect-ids.test.ts`
(FAKE ssh, ssh-keygen, ssh-keyscan and tailscale programs) and `tests/connect-real-ssh.test.ts` (real OpenSSH: it skips
where ssh and sshd are absent, as in the development container); Cloud's are `tests/cloud-*.test.ts`, against the
SIMULATED provider; God's Eye View's are in `tests/overview-remote.test.ts`. The row for each of these in Timmy's whole
matrix is in [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md).

| Capability | Researched | Implemented | Simulated | Tested | Live-qualified |
|---|---|---|---|---|---|
| **Connect.** Device records (no secrets in them; a key is named by its file, never copied) | ✓ | ✓ slice 1 (H90): `timmy connect add`, `/connect add`; `devices.json` at 0600 | ✓ FAKE OpenSSH programs | ✓ | partial: r24, on the Mac, against an sshd the test started on 127.0.0.1 (the real-OpenSSH test, 6 of 6); no record of another computer |
| Reach over a tailnet (Tailscale as the network; its own SSH kept apart) | ✓ | partial: `timmy connect tailnet` lists the peers `tailscale status --json` gives, read only; it adds nothing | ✓ a FAKE tailscale | ✓ | – |
| OpenSSH from macOS and Linux: batch mode, Timmy's own known-hosts file, a host key pinned only when a person confirms its fingerprint | ✓ | ✓ | ✓ | ✓ | partial: r24: host keys scanned, a wrong fingerprint refused and the right one trusted, a changed host key and a stranger's key refused, on the Mac's own 127.0.0.1 (OpenSSH 10.3p1) |
| Native Windows through Microsoft's OpenSSH Server (its default shell is cmd unless set; PowerShell commands sent encoded) | ✓ | ✓ the command shapes | ✓ | ✓ the shapes checked | – (no Windows computer here) |
| Remote jobs that outlive a dropped connection and are reconciled before any retry | ✓ | ✓ | ✓ | ✓ | partial: r24: a detached job found and ended after its local ssh was killed; one id sent twice started one run (127.0.0.1) |
| Cancellation said exactly: stopping the local `ssh` is not stopping the remote job | ✓ | ✓ | ✓ | ✓ | partial: r24: a stop confirmed, and a stop refused while the job's status named an unrelated process (127.0.0.1) |
| Results fetched back, sha256 checked on both computers | ✓ | ✓ | ✓ | ✓ | partial: r24: a fetch with sha256 equal, and a link swapped in never followed (127.0.0.1) |
| What a computer can do (CAD, rendering, GPU, native apps): each by a run of its own, never by the connection | ✓ | – | – | – | – |
| Customers on their own tailnets or plain SSH, never on the operator's tailnet (creating a tailnet by API is a private alpha, for API use only) | ✓ | – | – | – | – |
| **Cloud.** A backend that alone holds the agency credentials, from a secret store | ✓ | partial: the backend (H91; `services/cloud`, outside the npm package) reads the credential from `TIMMY_CLOUD_AGENCY_TOKEN` or a 0600 file and keeps it out of every word it writes; no secret store yet | ✓ the SIMULATED provider | ✓ | – |
| Customers, the Pro entitlement and who owns each resource; another customer's resource refused | ✓ | ✓ | ✓ | ✓ | – |
| Orders as durable steps (quoted, approved, paid, accepted, provisioned, DNS ready, healthy), each with its own state, reconciled by reading the provider | ✓ | ✓ write-ahead provider calls, reconcile after a lost answer or a crash | ✓ | ✓ | – |
| Spending limits and approvals: nothing bought without a quote inside the customer's limit and, by default, the operator's approval | ✓ | ✓ | ✓ | ✓ | – |
| Provider payments (a 202 means still processing), failed payments, partial provisioning | ✓ | ✓ | ✓ as the simulated provider models them | ✓ | – |
| Hostinger adapter, private overlay (four reads: websites, a selected domain's DNS records, VPS list and one VPS) | ✓ | ✓ private, read only | ✓ its own fakes | its README reports 11 offline tests (not re-run here) | – |
| Agency Plan sites: setup, domains, SSL, deploy from an archive (operations as the official MCP server 2.11.0 documents them) | ✓ | partial: a site's setup, its domain's link and its certificate as an order's steps; deploying an archive is named in the provider interface and on HOLD (no route calls it) | ✓ | ✓ | – |
| VPS purchase and status | ✓ | partial: a purchase and its setup as an order's steps | ✓ | ✓ | – |
| DNS changes: a plan and a diff only; no write | ✓ | – (an order's DNS step is the provider's domain link, simulated; no record plan or diff is built) | – | – | – |
| Cancelling Pro: nothing deleted; each site and domain retained with a person's decision; an export | ✓ | ✓ retention items: export each site and VPS, decide each domain | ✓ | ✓ | – |
| Customer access to hosting panels: the official API (as the MCP server 2.11.0 documents it) has no operation for sharing access, and hPanel's account sharing is done by hand, so none is built | ✓ | – (none, by design) | – | – | – |
| Timmy Cloud's client: `timmy cloud use\|status` and `/cloud` read the backend's overview and orders with the operator's token file (0600, never printed); the client changes nothing on the backend | ✓ | ✓ (H93) | ✓ the backend with its SIMULATED provider | ✓ `tests/cloud-client-backend.test.ts` | – (no backend is deployed; not run on the Mac) |
| **God's Eye View.** Devices (reach, last seen, OS, jobs) | ✓ | ✓ slice 2 (H93): `/overview` Devices, read from Timmy Connect's own records | ✓ FAKE OpenSSH programs | ✓ | – (r24 U3 showed the board's Devices card only in its empty state) |
| Sites, domains and VPS resources in steps, never one word for all | ✓ | ✓ slice 2: Hosting, from the answer the client kept | ✓ the SIMULATED provider | ✓ | – (r24 U3: the Hosting card, "not set up") |
| Provider costs, renewals and limits beside model spend | ✓ | partial: slice 2's Costs (provider costs and each customer's limits as the backend reports them); a domain's renew-or-lapse decision in Needs you | ✓ | ✓ | – |
| New things needing attention (a host key to confirm, a device asleep, an order awaiting approval, a payment that failed, a renewal due) | ✓ | ✓ slice 2: new kinds of Needs you | ✓ | ✓ | – |

## Slices

| Slice | Owner | Branch | Scope | State at `876755a` |
|---|---|---|---|---|
| Connect 1 | helper H90 | `r4/connect-1`, then `r4/connect-2` | device records, host-key pinning, probes, remote jobs with reconcile and cancel, fetching results, Windows command shapes; tests with a FAKE `ssh`, and a real-OpenSSH test where `ssh` and `sshd` exist | merged (`cc622cb`; the review's fixes `e18a6a8`); the real-OpenSSH test passed 6 of 6 on the Mac in r24, on 127.0.0.1 only |
| Cloud 1 | helper H91 | `r4/cloud-1`, then `r4/cloud-2` | the backend's provider-neutral core: customers, entitlement, limits, orders as durable steps, reconcile, cancellation, retention; a simulated provider; a local HTTP API; tests for every case the order names | merged (`4e6eb03`; the review's fixes `a300851`); simulated only |
| Companion | helper H92 | `r4/companion-local` | the browser companion's page loads nothing from public CDNs (its scripts ran with the page's token: row 173), with a strict content security policy | merged (`efe3550`; H95's page since `5a00e88`); r24 and r25 saw every request of the installed page go to Timmy's own servers |
| God's Eye View 2, and Cloud's client | helper H93 | `r4/gods-eye-2` | devices, hosting, provider costs and the new attention kinds, through the same readers; `timmy cloud use\|status` and `/cloud` | merged (`d3d2db0`); tested with FAKE OpenSSH programs and the SIMULATED provider; not run on the Mac with data (r24 showed its cards empty) |

## Before any live step: what the operator gets to approve

Each live step comes as a plan with its exact commands, its cost, what it changes and how to undo it, and nothing runs
until the operator approves that step:

- **A read of the operator's Hostinger account** (the private adapter's four reads): cost none; changes nothing; needs a
  token made available to the backend privately; undo: revoke the token.
- **SSH to a named computer of the operator's**: cost none; changes the computer's authorized keys (one line, a key made
  for Timmy) and creates a folder for Timmy's job records; undo: remove that line and that folder.
- **Native Windows**: enabling Microsoft's OpenSSH Server is a machine service change: the plan names the commands, the
  firewall rule, the key file and its permissions, and how to turn it all off.
- **Any purchase, DNS change, deployment or deletion**: a quote from the provider's catalog, the limit it falls under, the
  steps and their order, what a failure at each step leaves, and the recovery the provider actually offers.
