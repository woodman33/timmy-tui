// Real Ink/PTY keyboard fixture. External integrations are deliberately unavailable;
// this does not qualify the full CLI, providers, native tools, or live agents.
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
if (process.env.TIMMY_PTY_FIXTURE !== '1'
  || process.env.TIMMY_STORE !== join(root, 'receipts')
  || process.env.HOME !== join(root, 'home')
  || process.env.TIMMY_PRIVATE_DIR !== join(root, 'private')) {
  throw new Error('keyboard fixture requires its isolated launcher');
}
writeFileSync(join(root, 'child.json'), JSON.stringify({ pid: process.pid, run: process.argv.at(-1) }));

const began = performance.now();
const milestone = (phase: string) => appendFileSync(join(root, 'progress.jsonl'), JSON.stringify({ phase, elapsed_ms: performance.now() - began }) + '\n');
milestone('helper-start');

function refuse(kind: string): never {
  appendFileSync(join(root, 'violations.jsonl'), JSON.stringify({ kind, stack: new Error().stack }) + '\n');
  throw new Error(`PTY fixture forbids ${kind}`);
}

// Install before importing the application graph. No inherited endpoint or tool
// can become live during a keyboard regression. Record attempts, even if caught.
net.Socket.prototype.connect = (() => refuse('network')) as typeof net.Socket.prototype.connect;
tls.connect = (() => refuse('tls')) as typeof tls.connect;
const localFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  // Yoga loads its bundled base64 WASM through a data URL; it has no network.
  if (String(input).startsWith('data:application/octet-stream;base64,')) return localFetch(input, init);
  return refuse('fetch');
}) as typeof fetch;
globalThis.WebSocket = class { constructor() { refuse('websocket'); } } as unknown as typeof WebSocket;
childProcess.spawn = (() => refuse('spawn')) as typeof childProcess.spawn;
childProcess.exec = (() => refuse('exec')) as unknown as typeof childProcess.exec;
childProcess.execFile = (() => refuse('execFile')) as unknown as typeof childProcess.execFile;
childProcess.fork = (() => refuse('fork')) as typeof childProcess.fork;
childProcess.execSync = (() => refuse('execSync')) as typeof childProcess.execSync;
childProcess.execFileSync = (() => refuse('execFileSync')) as typeof childProcess.execFileSync;
childProcess.spawnSync = ((command: string, args: string[] = []) => {
  const readOnlyProbe = (command === 'docker' && ['info', 'ps'].includes(args[0]))
    || (command === 'tmux' && args[0] === 'list-panes')
    || (command === 'command' && args[0] === '-v');
  if (!readOnlyProbe) refuse('unexpected subprocess');
  return { pid: 0, status: 1, signal: null, stdout: '', stderr: 'fixture: unavailable', output: [null, '', 'fixture: unavailable'] };
}) as typeof childProcess.spawnSync;
syncBuiltinESMExports();

milestone('guards-installed');
const { default: React } = await import('react');
milestone('react-imported');
const { render } = await import('ink');
milestone('ink-imported');
const { ShellV2 } = await import('../../src/tui/components/ShellV2.js');
milestone('shell-imported');
const agent = {
  on() {}, off() {}, getModel: () => 'fixture/keyboard', totalCost: 0,
  conversation: { getHistory: () => [] },
  send: async () => refuse('agent send'), clearHistory() {}, setModel() {},
};
milestone('before-render');
const view = render(React.createElement(ShellV2, { width: 120, agent: agent as never }));
milestone('render-returned');
const stop = () => { view.unmount(); process.exit(0); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
setTimeout(() => { refuse('watchdog expired'); }, 90000).unref();
await view.waitUntilExit();
