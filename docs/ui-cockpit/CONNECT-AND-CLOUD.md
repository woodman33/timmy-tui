# Timmy Connect and Timmy Cloud: capability matrix and slices

Status (2026-10-11): **researched**; the first slice of each is in development, offline and isolated. Nothing has been
provisioned or bought, no provider account has been read, and no computer's services have been changed. The private
Hostinger adapter (outside this repository) is read only and its account access is not validated.

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
against a stand-in (a FAKE program or a simulated provider). Tested: automated tests pass. Live-qualified: run for real
against the real computer or account, with the evidence kept. Every cell is – until a row in CHECKPOINTS.md says otherwise.

| Capability | Researched | Implemented | Simulated | Tested | Live-qualified |
|---|---|---|---|---|---|
| **Connect.** Device records (no secrets in them; a key is named by its file, never copied) | ✓ | – | – | – | – |
| Reach over a tailnet (Tailscale as the network; its own SSH kept apart) | ✓ | – | – | – | – |
| OpenSSH from macOS and Linux: batch mode, Timmy's own known-hosts file, a host key pinned only when a person confirms its fingerprint | ✓ | – | – | – | – |
| Native Windows through Microsoft's OpenSSH Server (its default shell is cmd unless set; PowerShell commands sent encoded) | ✓ | – | – | – | – (no Windows computer here) |
| Remote jobs that outlive a dropped connection and are reconciled before any retry | ✓ | – | – | – | – |
| Cancellation said exactly: stopping the local `ssh` is not stopping the remote job | ✓ | – | – | – | – |
| Results fetched back, sha256 checked on both computers | ✓ | – | – | – | – |
| What a computer can do (CAD, rendering, GPU, native apps): each by a run of its own, never by the connection | ✓ | – | – | – | – |
| Customers on their own tailnets or plain SSH, never on the operator's tailnet (creating a tailnet by API is a private alpha, for API use only) | ✓ | – | – | – | – |
| **Cloud.** A backend that alone holds the agency credentials, from a secret store | ✓ | – | – | – | – |
| Customers, the Pro entitlement and who owns each resource; another customer's resource refused | ✓ | – | – | – | – |
| Orders as durable steps (quoted, approved, paid, accepted, provisioned, DNS ready, healthy), each with its own state, reconciled by reading the provider | ✓ | – | – | – | – |
| Spending limits and approvals: nothing bought without a quote inside the customer's limit and, by default, the operator's approval | ✓ | – | – | – | – |
| Provider payments (a 202 means still processing), failed payments, partial provisioning | ✓ | – | – | – | – |
| Hostinger adapter, private overlay (four reads: websites, a selected domain's DNS records, VPS list and one VPS) | ✓ | ✓ private, read only | ✓ its own fakes | its README reports 11 offline tests (not re-run here) | – |
| Agency Plan sites: setup, domains, SSL, deploy from an archive (operations as the official MCP server 2.11.0 documents them) | ✓ | – | – | – | – |
| VPS purchase and status | ✓ | – | – | – | – |
| DNS changes: a plan and a diff only; no write | ✓ | – | – | – | – |
| Cancelling Pro: nothing deleted; each site and domain retained with a person's decision; an export | ✓ | – | – | – | – |
| Customer access to hosting panels: the official API (as the MCP server 2.11.0 documents it) has no operation for sharing access, and hPanel's account sharing is done by hand, so none is built | ✓ | – | – | – | – |
| **God's Eye View.** Devices (reach, last seen, OS, jobs) | ✓ | – | – | – | – |
| Sites, domains and VPS resources in steps, never one word for all | ✓ | – | – | – | – |
| Provider costs, renewals and limits beside model spend | ✓ | – | – | – | – |
| New things needing attention (a host key to confirm, a device asleep, an order awaiting approval, a payment that failed, a renewal due) | ✓ | – | – | – | – |

## Slices

| Slice | Owner | Branch | Scope |
|---|---|---|---|
| Connect 1 | helper H90 | `r4/connect-1` | device records, host-key pinning, probes, remote jobs with reconcile and cancel, fetching results, Windows command shapes; tests with a FAKE `ssh`, and a real-OpenSSH test where `ssh` and `sshd` exist |
| Cloud 1 | helper H91 | `r4/cloud-1` | the backend's provider-neutral core: customers, entitlement, limits, orders as durable steps, reconcile, cancellation, retention; a simulated provider; a local HTTP API; tests for every case the order names |
| Companion | helper H92 | `r4/companion-local` | the browser companion's page loads nothing from public CDNs (its scripts ran with the page's token: row 173), with a strict content security policy |
| God's Eye View 2 | after Connect 1 and Cloud 1 | – | devices, hosting, provider costs and the new attention kinds, through the same readers |

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
