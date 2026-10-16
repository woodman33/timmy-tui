/**
 * R6 (H144): the FAKE run the run inspection's tests make (tests/ops-run-inspection.test.ts, tests/companion-run-inspect-
 * browser.test.ts, tests/workbench-workflows-tab.test.ts): a real /run, in the REPL's own Workspace, of REPORT.md, this
 * helper's FAKE workflow:
 *   change   `fake-params-flow 150`: tests/fixtures/fake-params-flow.ts, a TEST DOUBLE of what `/iterate tray` leaves when
 *            its agent changes the tray's width (no agent runs, nothing is built): the parameter file's bytes kept as read,
 *            the width changed, the flow record written through Timmy's own writer and a real flow receipt sealed under
 *            the block's operation;
 *   report   writes out/report.md (text), out/summary.json (JSON), out/preview.png (an 8 by 6 PNG made here) and
 *            out/blob.bin (binary), and prints 60 lines.
 * upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; each block through sh -c).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect } from 'vitest';
import type { Workspace } from '../../src/repl/workspace.js';
import { FIXTURES, LOADER, text, type Sandbox } from './ops-sandbox.js';

const F = '```';
export const FAKE_FLOW = path.join(FIXTURES, 'fake-params-flow.ts');
export const TRAY_PARAMS = path.resolve(__dirname, '..', '..', 'templates', 'tray-workflow', 'recipes', 'tray.params.json');

/** A small PNG (w by h pixels, RGB), made here: the image the FAKE report block writes. */
export function png(w: number, h: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 40 * x; raw[i + 1] = 255 - 40 * y; raw[i + 2] = 180; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const PNG = png(8, 6);
export const BLOB = Buffer.from([0x42, 0x49, 0x4e, 0, 1, 2, 0xff]);

/** The FAKE workflow: `change` (the FAKE flow), then `report`, which writes out/ and prints 60 lines. */
export const REPORT = [
  '# FAKE report workflow (this test)', '',
  'The change block runs a TEST DOUBLE of /iterate; the report block writes a text, a JSON, an image and a binary.', '',
  `${F}bash [name:change]`, 'fake-params-flow 150', F, '',
  `${F}bash [name:report, deps:change]`,
  'mkdir -p out',
  "printf '# Report\\n\\nThe tray is 150 mm wide now.\\nFAKE: written by the test workflow.\\n' > out/report.md",
  "printf '{\"width\":150,\"files\":[\"out/report.md\",\"out/preview.png\"],\"ok\":true}\\n' > out/summary.json",
  `printf '%s' '${PNG.toString('base64')}' | base64 -d > out/preview.png`,
  "printf 'BIN\\000\\001\\002\\377' > out/blob.bin",
  'for i in $(seq 1 60); do echo "report line $i"; done',
  F, '',
].join('\n');

/** The project: the tray's parameter file, REPORT.md, and the FAKE flow command on the sandbox's PATH. */
export function reportProject(s: Sandbox): void {
  fs.mkdirSync(path.join(s.root, 'recipes'), { recursive: true });
  fs.copyFileSync(TRAY_PARAMS, path.join(s.root, 'recipes', 'tray.params.json'));
  fs.writeFileSync(path.join(s.root, 'REPORT.md'), REPORT);
  fs.writeFileSync(path.join(s.bin, 'fake-params-flow'), [
    '#!/bin/sh',
    '# FAKE: a TEST DOUBLE of /iterate changing the tray\'s width (tests/fixtures/fake-params-flow.ts)',
    `exec "${process.execPath}" --import "${LOADER}" "${FAKE_FLOW}" "$@"`, '',
  ].join('\n'), { mode: 0o755 });
}

/** `/run <doc> <block>` in the REPL, to its end: its job and operation. */
export async function runOf(ws: Workspace, doc: string, block: string): Promise<{ job: string; op: string }> {
  const started = text(await ws.operate(`/run ${doc} ${block}`, 'repl', () => ws.run(`${doc} ${block}`)));
  const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
  expect(job, started).toBeDefined();
  const h = ws.ops.latest!;
  const done = await ws.jobs.done(job!);
  expect(done.state, `${started}\n${ws.jobs.tail(job!, 80).join('\n')}`).toBe('completed');
  await ws.ops.done(h);
  return { job: job!, op: h.id };
}

/** A command typed in the REPL as one operation (the REPL's own), to its end: what it said and its operation. */
export async function typed(ws: Workspace, line: string, run: () => unknown): Promise<{ said: string; op: string }> {
  const said = text((await ws.operate(line, 'repl', run)) as { text: string }[][]);
  const h = ws.ops.latest!;
  await ws.ops.done(h);
  return { said, op: h.id };
}
