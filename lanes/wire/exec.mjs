#!/usr/bin/env node
// lanes/wire/exec.mjs — launch ONE bridge from lanes/wire/bridges.json with stdio inherited.
// Exists because mcp-probe takes a single --args value per occurrence and mcpc needs a config
// entry; both can spawn `node exec.mjs <bridge>` and get the real command, cwd and env.
// Env values (e.g. houdini-gen's PYTHONPATH / HOUDINI_GEN_ENV) are read from ~/.claude.json
// at launch time and never printed or written anywhere.
// usage: node lanes/wire/exec.mjs <bridge-name>   (or WIRE_BRIDGE=<name>)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(LANE, '..', '..');
const HOME = os.homedir();
const expand = (p) => String(p).replace(/^~(?=\/|$)/, HOME).replace(/\$ROOT/g, ROOT);

const name = process.argv[2] || process.env.WIRE_BRIDGE;
const reg = JSON.parse(fs.readFileSync(path.join(LANE, 'bridges.json'), 'utf8'));
const b = reg.bridges.find((x) => x.name === name);
if (!b) { process.stderr.write(`exec.mjs: unknown bridge "${name}"\n`); process.exit(2); }
if (b.transport !== 'stdio' || !b.command) { process.stderr.write(`exec.mjs: bridge "${name}" is not a stdio command\n`); process.exit(2); }

const env = { ...process.env };
if (b.envFrom) {
  const [file, key] = b.envFrom.split(':');
  if (file === 'claude.json') {
    try {
      const cj = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
      const e = ((cj.mcpServers || {})[key] || {}).env || {};
      for (const k of b.envNames || Object.keys(e)) if (e[k] !== undefined) env[k] = e[k];
    } catch (err) {
      process.stderr.write(`exec.mjs: could not read env for ${key} from ~/.claude.json: ${err.message}\n`);
    }
  }
}
for (const [k, v] of Object.entries(b.envSet || {})) env[k] = expand(v);

const cwd = path.resolve(ROOT, expand(b.cwd || '.'));
let command = expand(b.command);
if (command === 'node') command = process.execPath;
else if (command.includes('/')) command = path.resolve(cwd, command);
const args = (b.args || []).map(expand);

const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
child.on('error', (e) => { process.stderr.write(`exec.mjs: spawn ${command} failed: ${e.code || e.message}\n`); process.exit(127); });
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 128 : 1)));
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch {} });
// If the wrapper is SIGKILLed (mcpsnoop / mcpc tearing down), we get re-parented to launchd (ppid 1):
// take the real server down with us instead of leaving a stray.
setInterval(() => {
  if (process.ppid === 1) {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 1000);
  }
}, 500);
