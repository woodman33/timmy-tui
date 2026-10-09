#!/usr/bin/env node
// fake-aerender.mjs: a TEST DOUBLE of After Effects' aerender, for tests/native.test.ts. It is not
// aerender and renders nothing. It reproduces only the command line Timmy builds:
//   aerender -project <file.aep|file.aepx> -comp "<name>" -output <file> [-s <frame>] [-e <frame>]
//            [-RStemplate <t>] [-OMtemplate <t>]
// aerender renders an EXISTING project; it cannot make or edit one. A missing project file is an error.
// An output named with [####] is an image sequence: the fake writes one file per frame, the frame number
// zero-padded to the width of the #s, from -s to -e (default 0 to 3).
// FAKE_AERENDER_MODE picks what it does once the project file is found:
//   ok         (the default) writes a few bytes to the -output file (each frame of a sequence); exits 0
//   no-output  writes nothing and exits 0
//   error      prints an error and exits 1
//   one-frame  a sequence: writes only its first frame; exits 0
//   gap        a sequence: writes every frame but the middle one; exits 0
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const project = flag('-project');
const comp = flag('-comp');
const output = flag('-output');
const mode = process.env.FAKE_AERENDER_MODE || 'ok';

process.stdout.write(`PROGRESS: fake-aerender ${comp ?? '(no comp)'}\n`);
if (!project || !existsSync(project)) {
  process.stderr.write(`aerender ERROR: no project file at ${project ?? '(none given)'} (fake)\n`);
  process.exit(1);
}
if (mode === 'error') { process.stderr.write('aerender ERROR: render failed (fake)\n'); process.exit(1); }
if (mode !== 'no-output' && output) {
  mkdirSync(path.dirname(output), { recursive: true });
  const seq = /\[(#+)\]/.exec(path.basename(output));
  if (!seq) writeFileSync(output, 'fake movie bytes\n');
  else {
    const width = seq[1].length;
    const s = Number(flag('-s') ?? 0);
    const e = Number(flag('-e') ?? s + 3);
    const middle = Math.floor((s + e) / 2);
    for (let f = s; f <= e; f++) {
      if (mode === 'one-frame' && f !== s) continue;
      if (mode === 'gap' && f === middle) continue;
      const name = path.basename(output).replace(/\[#+\]/, String(f).padStart(width, '0'));
      writeFileSync(path.join(path.dirname(output), name), `fake frame ${f}\n`);
    }
  }
}
process.stdout.write('PROGRESS: Total Time Elapsed: 1 Seconds (fake)\n');
process.exit(0);
