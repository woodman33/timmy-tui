#!/usr/bin/env node
// fake-aerender.mjs: a TEST DOUBLE of After Effects' aerender, for tests/native.test.ts. It is not
// aerender and renders nothing. It reproduces only the command line Timmy builds:
//   aerender -project <file.aep|file.aepx> -comp "<name>" -output <file> [-RStemplate <t>] [-OMtemplate <t>]
// aerender renders an EXISTING project; it cannot make or edit one. A missing project file is an error.
// FAKE_AERENDER_MODE picks what it does once the project file is found:
//   ok         (the default) writes a few bytes to the -output file and exits 0
//   no-output  writes nothing and exits 0
//   error      prints an error and exits 1
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
if (mode === 'ok' && output) {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, 'fake movie bytes\n');
}
process.stdout.write('PROGRESS: Total Time Elapsed: 1 Seconds (fake)\n');
process.exit(0);
