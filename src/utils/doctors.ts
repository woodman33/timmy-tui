import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { lookup } from 'dns/promises';
import { connect } from 'net';
import { connect as tlsConnect } from 'tls';
import { request as httpsRequest } from 'https';
import { appendReceipt } from './receipts.js';
import { edgeHost, EDGE_INERT_LINE } from './edge-host.js';

// Read-only doctors. External tools (depguard, llmfit, network-doctor ideas)
// are consumed as ADAPTERS: they inspect, Timmy receipts. Never auto-fix —
// lifecycle-script and network mutations stay approval-gated typed effects.

export interface DoctorRow { label: string; ok: boolean; note: string }

const has = (cmd: string): boolean => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

export function depsDoctor(dir: string = process.cwd()): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const lock = existsSync(join(dir, 'package-lock.json'));
  rows.push({ label: 'lockfile', ok: lock, note: lock ? 'package-lock.json present — installs reproducible' : 'no lockfile — installs are not reproducible' });
  const npmrc = join(dir, '.npmrc');
  if (existsSync(npmrc)) {
    const txt = readFileSync(npmrc, 'utf8');
    const gated = /allow-scripts\s*=\s*true/i.test(txt);
    rows.push({ label: 'npm lifecycle scripts', ok: gated, note: gated ? 'allow-scripts=true — lifecycle scripts gated by allowlist' : 'allow-scripts not enabled — lifecycle scripts run unchecked' });
  } else {
    rows.push({ label: 'npm lifecycle scripts', ok: false, note: 'no .npmrc — npm defaults (unchecked lifecycle scripts)' });
  }
  rows.push({ label: 'depguard', ok: has('depguard'), note: has('depguard') ? 'installed — read-only package-manager config checks available' : 'not installed (optional, read-only CI checks)' });
  return rows;
}

type Layer = 'dns' | 'tcp' | 'tls' | 'http' | 'ok';

const probe = (host: string): Promise<Layer> => new Promise(resolve => {
  const fail = (l: Layer) => resolve(l);
  lookup(host).then(() => {
    const sock = connect({ host, port: 443, timeout: 4000 }, () => {
      sock.destroy();
      const tls = tlsConnect({ host, port: 443, timeout: 4000, servername: host }, () => {
        tls.destroy();
        const req = httpsRequest({ host, path: '/', method: 'HEAD', timeout: 4000 }, res => {
          res.resume();
          resolve(res.statusCode && res.statusCode < 500 ? 'ok' : 'http');
        });
        req.on('timeout', () => { req.destroy(); fail('http'); });
        req.on('error', () => fail('http'));
        req.end();
      });
      tls.on('error', () => fail('tls'));
      tls.on('timeout', () => { tls.destroy(); fail('tls'); });
    });
    sock.on('timeout', () => { sock.destroy(); fail('tcp'); });
    sock.on('error', () => fail('tcp'));
  }).catch(() => fail('dns'));
});

export async function networkDoctor(dir?: string): Promise<DoctorRow[]> {
  // hosts-j4t1: the edge host is a config read; unresolved it is inert and
  // fails with one legible line instead of probing a placeholder
  const edge = edgeHost();
  const targets = edge ? ['openrouter.ai', edge] : ['openrouter.ai'];
  const rows: DoctorRow[] = [];
  if (!edge) rows.push({ label: 'edge', ok: false, note: EDGE_INERT_LINE });
  for (const host of targets) {
    const layer = await probe(host);
    rows.push({
      label: host,
      ok: layer === 'ok',
      note: layer === 'ok'
        ? 'dns → tcp → tls → http all good'
        : `fails at ${layer.toUpperCase()} layer — everything before it is fine`
    });
  }
  try {
    appendReceipt('doctor', {
      kind: 'network-check',
      subject: rows.map(r => `${r.label}:${r.ok ? 'ok' : r.note.split(' ')[2] ?? 'fail'}`).join(' '),
      policy: 'auto'
    }, dir);
  } catch { /* doctor never breaks the spine */ }
  return rows;
}

export function hardwareDoctor(): DoctorRow[] {
  const rows: DoctorRow[] = [];
  try {
    const mem = Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) / 1e9;
    const cpu = execFileSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    rows.push({ label: 'cpu/mem', ok: true, note: `${cpu} cores · ${mem.toFixed(0)} GB unified` });
  } catch {
    rows.push({ label: 'cpu/mem', ok: false, note: 'sysctl unavailable (non-mac host?)' });
  }
  if (has('nvidia-smi')) {
    try {
      const gpus = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      rows.push({ label: 'nvidia', ok: true, note: gpus.split('\n').join(' · ') });
    } catch {
      rows.push({ label: 'nvidia', ok: false, note: 'nvidia-smi present but query failed' });
    }
  } else {
    rows.push({ label: 'nvidia', ok: true, note: 'no nvidia-smi — Apple/local-CPU inference path' });
  }
  rows.push({ label: 'llmfit', ok: has('llmfit'), note: has('llmfit') ? 'installed — model/fit shortlist available (estimates only; measured TTFT/OOM history routes)' : 'not installed (optional companion for model-fit shortlists)' });
  rows.push({
    label: 'framework-tool-tui',
    ok: has('framework-tool-tui'),
    note: has('framework-tool-tui')
      ? (process.platform === 'linux' ? 'installed — Framework hardware monitor live' : 'installed — Linux-only monitor; not applicable on darwin')
      : 'not installed (cargo install framework-tool-tui · Linux/Framework hardware only)'
  });
  return rows;
}

export function printRows(title: string, rows: DoctorRow[]): void {
  console.log(`TIMMY Doctor — ${title} (read-only, never auto-fixes)`);
  for (const r of rows) console.log(`${r.ok ? '✓' : '⚠'} ${r.label.padEnd(28)} ${r.note}`);
}
