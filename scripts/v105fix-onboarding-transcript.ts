// v1.0.5-fix headless onboarding transcript: drives the real App through
// splash → setup → teach gates → cold View [1] and prints the key frames.
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { App } from '../src/tui/app.js';

process.env.TIMMY_TELEMETRY_URL = 'off';
process.chdir(mkdtempSync(join(tmpdir(), 'timmy-transcript-')));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pick = (f: string | undefined, re: RegExp) =>
  (f ?? '').split('\n').filter(l => re.test(l)).slice(0, 6).join('\n');

const view = render(React.createElement(App, { config: {} as never }));
await sleep(500);
console.log('══ SPLASH ══');
console.log(pick(view.lastFrame(), /Flight Recorder|Begin setup|degraded|███/));

view.stdin.write('\r'); await sleep(250);
console.log('══ PROVIDER ══');
console.log(pick(view.lastFrame(), /PICK A BRAIN|\[b\]|\[o\]|\[k\]/));

view.stdin.write('o'); await sleep(200);   // ollama-only
view.stdin.write('l'); await sleep(200);   // local-only sync
console.log('══ LOGS ══');
console.log(pick(view.lastFrame(), /LOG ORGANIZATION|\[1\]|\[2\]/));
view.stdin.write('1'); await sleep(150);
view.stdin.write('\r'); await sleep(150);
view.stdin.write('d'); await sleep(150);
view.stdin.write('\r'); await sleep(250);  // → teach 1/3

console.log('══ TEACH 1/3 (wrong key then 2) ══');
view.stdin.write('x'); await sleep(200);
console.log(pick(view.lastFrame(), /TEACH 1\/3|not that one/));
view.stdin.write('2'); await sleep(200);
console.log(pick(view.lastFrame(), /TEACH 2\/3/));

view.stdin.write('\x0b'); await sleep(200); // ctrl+k
console.log('══ TEACH 3/3 ══');
console.log(pick(view.lastFrame(), /TEACH 3\/3/));

view.stdin.write('1'); await sleep(500);    // finish → View [1]
console.log('══ COLD VIEW [1] ══');
console.log(pick(view.lastFrame(), /cold start|Type a mission|\[2\] MISSION|\[1 COM\]/));
view.unmount();
process.exit(0);
