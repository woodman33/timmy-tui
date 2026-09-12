# NFC programming lane

Turns a blank NTAG 424 DNA TagTamper sticker into a Vault Custody seal: the
URL that points at `/t`, Secure Dynamic Messaging switched on so every tap
carries a fresh encrypted UID + counter and a CMAC, and per-tag keys derived
from the batch master in place of the factory zeros. Each programmed tag is
read back and its URL is run through the edge verifier before anything is
sealed.

```
timmy nfc selftest                                   # the chip layer's no-hardware checks
timmy nfc template --base https://v.vlt.to           # the URL and the mirror offsets
timmy nfc program --batch paradise-001 --count 10    # ten stickers, one after another
timmy nfc program --batch bench-001 --count 1 --bench --part plain   # a plain 424 on the bench
```

## Hardware

- ACR122U (or any PC/SC reader that passes ISO 14443-4 APDUs). macOS ships
  PC/SC; nothing to install for the reader itself.
- `nfc-pcsc` is a native module and lives beside this lane, not in the repo
  root: `npm --prefix lanes/nfc install`. Everything that does not need a
  reader — self-test, template, dry run — works without it.
- Stock: NTAG 424 DNA **TagTamper** for production (the loop is the point).
  A plain NTAG 424 DNA is fine for bench work: `--part plain`, and the receipt
  says so, because the two templates differ (no `tt=` on the plain part).

## What one tag goes through

1. UID and GetVersion. A chip that is not a 424 DNA, or whose tamper loop does
   not match `--part`, stops the run.
2. Keys for this tag are derived from the batch master by
   `vault-custody/src/lib/divkey.ts`, the same module the edge calls. Meta-read
   key per batch, file-read key per tag, application master per tag (see the
   module header for why the meta key cannot be per tag).
3. Authenticate with the factory key 0. A tag that refuses was programmed
   before and is left alone.
4. Write the NDEF URL template. Placeholders are `0`, so an un-mirrored tag
   yields a dead URL, never a plausible one.
5. Enable SDM with offsets computed from the template, never counted by hand.
6. Change key 1 (meta), key 2 (file), then key 0 last: it ends the session.
7. Read the tag back. The chip fills the mirrors on that read; the URL goes
   through `verifyTap` with the derived keys. No pass, no receipt, and the
   tag is set aside by UID.
8. Seal `tag.program` and append a line to `lanes/nfc/batches/<batch>.jsonl`.

## The receipt

`tag.program` carries: `uid`, `batch`, `role`, `part`, `bench`,
`key_derivation` (the scheme id), `meta_key_fp` and `file_key_fp` (eight-byte
CMAC fingerprints, not keys), `url_template_sha256`, the three file offsets,
`readback_counter`, `readback_loop`, and `serial` when `--serial-start` was
given. Keys never appear in a receipt, a log, or this README.

## Keys

Masters come from the environment or the gitignored worktree `.env`:

```
CUSTODY_MASTER_META_PARADISE_001=<16 bytes hex>
CUSTODY_MASTER_FILE_PARADISE_001=<16 bytes hex>
```

or from a `diversified` keyset named after the batch inside `CUSTODY_KEYS`,
which is the same JSON the Pages Function reads. The lane prints that keyset
entry (with the masters redacted) at the end of a run; put the real one into
the edge with `wrangler pages secret put CUSTODY_KEYS`.

A production batch with missing or all-zero masters is refused before the
reader is opened. `--bench` is the only way past that, and the receipt records
it.

## What is proven, and what is not

Proven without hardware, and run on every test pass:

- the AN10922 derivation reproduces NXP's published vector
  (`vault-custody/test/divkey.test.ts`)
- the template's offsets round-trip: a simulated tag fills them, the real
  verifier accepts the result, and a one-byte slip in either offset fails
  (`vault-custody/test/sdmurl.test.ts`)
- the chip layer's arithmetic: CMAC against RFC 4493, the ChangeKey CRC, the
  session-vector layout, padding, NDEF framing, offset shift
  (`node lanes/nfc/selftest.mjs`)

Not proven: anything that needs a chip. NXP publishes no worked
AuthenticateEV2First vector, so the session construction in `ev2.mjs` is
implemented from AN12196 and cross-read against public implementations, and
has not met a reader. The read-back in step 7 is what stands in for that. The
first real tag is the first real test; program one, not ten.
