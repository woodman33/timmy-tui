# Forge ledger storage contract

The local render ledger stores operational records in
`<resolved-store>/forge/ledger.jsonl`, honoring the existing store resolver and
store pin (`TIMMY_STORE` applies when using the default current directory).
Keep generated ledgers, credentials, provider payloads, and private run reports
out of version control. Source, synthetic tests, and this contract belong in the
application repository.

`appendLedger` normalizes input to its JSON representation, rejects caller-owned
metadata (`seq`, `ts`, `prev_hash`, `hash`, `hash_version`), verifies the existing
chain under the writer lock, and appends one complete newline-terminated record.
Returned values match the representation retained on disk. Invalid input or
corrupt history refuses without rewriting existing ledger bytes.

Reads verify hashes, sequence, and links by default. Malformed records, blank
lines, incomplete final records, and unsupported hash versions always refuse.
`readLedger(dir, { verify: false })` is a diagnostic escape hatch for well-formed
records; it skips hash/link verification and must not authorize operational
decisions. `ledgerHead` uses verified reads.

New rows use `hash_version: 2`, recursive object-key sorting, and order-sensitive
arrays. Historical unversioned rows accept either established encoding:
top-level-only sorting from the initial writer, or recursive sorting from its
successor. Both cover every retained field; historical rows are never rehashed
or rewritten. An independently constructed original-format fixture tests that
compatibility and rejection of modified nested values.

Hashes establish internal consistency, not authenticity or protection against
complete replacement or removal of a valid suffix. Those claims require an
independently retained trusted head or receipt. This module adds no signatures.
Storage and locking remain synchronous; this repair does not establish async
execution or new provider qualification.

## Historical design and plan

The September 17 design and implementation plan are retained in the private
review archive and local commit history, outside the application distribution. Their sample code is not the current implementation or
execution authority. In particular, do not reuse the plan's ledger hash sample,
credential-redaction sample, or judge aggregation sample as production code.
Use the current modules and their tests, with separate review of their own
changes. The design's sandbox, egress, and globally installed SDK assumptions
are intended integration boundaries, not proof of enforcement or a reproducible
installation. The plan explicitly replaces the design's SQLite proposal with
JSONL storage. No historical approval authorizes a new live or paid run.
