// toolchain-e2a4 close: script ledger v0 — seal writes a sidecar, cut emits
// fountain, ledger reads sidecar+chain; missing inputs refuse (DOCTRINE §14).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sealScript, cutScript, ledgerTroff, sidecarPath, shaOfFile } from '../src/utils/scriptledger.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'timmy-script-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('script ledger v0', () => {
  it('seal writes sidecar with sha + receipt; cut emits fountain; ledger cites both', () => {
    const f = join(dir, 'ch.txt');
    writeFileSync(f, 'INT. WAREHOUSE - NIGHT\nthe stack breathes\nMIKE:\nwe seal before we cut\n');
    const s1 = sealScript(f);
    expect(s1.ok).toBe(true);
    const sc = JSON.parse(readFileSync(sidecarPath(f), 'utf8'));
    expect(sc.sha256).toBe(shaOfFile(f));
    expect(sc.seals.length).toBe(1);

    const out = join(dir, 'ch.fountain');
    const c = cutScript(f, out);
    expect(c.ok).toBe(true);
    expect(c.scenes).toBe(1);
    const fo = readFileSync(out, 'utf8');
    expect(fo).toContain('INT. WAREHOUSE - NIGHT');
    expect(fo).toContain('MIKE:');

    const l = ledgerTroff(f);
    expect(l.ok).toBe(true);
    expect(l.entries).toBeGreaterThanOrEqual(2); // seal + cut receipts
    expect(l.troff).toContain('script.seal');
  });

  it('missing script refuses without sealing', () => {
    const r = sealScript(join(dir, 'nope.txt'));
    expect(r.ok).toBe(false);
    expect(existsSync(sidecarPath(join(dir, 'nope.txt')))).toBe(false);
  });
});
