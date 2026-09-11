#!/usr/bin/env node
// timmy privacy — the public-repo privacy gate (ORDER privacy-d5n9).
//
//   timmy privacy scan [--tree <dir>] [--staged] [--ref <ref>] [--history [--all]] [--json out.json] [--md out.md]
//        [--severity critical,high,medium,review] [--patterns file] [--quiet]
//   timmy privacy audit                          tree (every open order worktree) + full history, report + privacy.audit seal
//   timmy privacy fixture                        the §12 negative control: scans lanes/privacy/fixtures/must-fail.txt and MUST find it
//   timmy privacy hook install|check             the pre-commit hook (scans the staged diff; a match blocks the commit)
//
// Findings: { file, line, pattern, severity, match (masked), where: tree|staged|history, commit? }.
// Exit code 1 when any finding at or above --fail-on (default: medium) exists — that is the gate.
// Nothing here writes to the repo besides the reports it is told to write.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const cmd = args.find((a) => !a.startsWith('--') && !['tree', 'staged', 'ref', 'history', 'json', 'md', 'severity', 'patterns', 'fail-on', 'since'].some((f) => args[args.indexOf(a) - 1] === `--${f}`)) ?? 'scan';
const SEV = { critical: 4, high: 3, medium: 2, review: 1 };
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function loadPatterns(file = flag('--patterns', join(HERE, 'patterns.json'))) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  return {
    patterns: p.patterns.map((x) => ({ ...x, rx: new RegExp(x.re, (x.flags ?? '') + 'g') })),
    allow: p.allow.map((a) => new RegExp(a)),
    ignore: p.ignore_paths.map((a) => new RegExp(a)),
    sha256: sha(readFileSync(file, 'utf8')),
    file
  };
}

/** A finding's match is masked in reports: first 3 + last 2 chars, so the report never repeats the secret. */
const mask = (m) => (m.length <= 6 ? m[0] + '…' : m.slice(0, 3) + '…' + m.slice(-2));

export function scanText(text, file, P, where, extra = {}) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (P.allow.some((a) => a.test(line))) continue;
    for (const p of P.patterns) {
      p.rx.lastIndex = 0;
      let m;
      while ((m = p.rx.exec(line))) {
        out.push({ file, line: i + 1, pattern: p.id, severity: p.severity, match: mask(m[0]), col: m.index + 1, where, ...extra });
        if (m.index === p.rx.lastIndex) p.rx.lastIndex++;
        if (out.length > 5000) return out;
      }
    }
  }
  return out;
}

const isBinary = (buf) => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; };

function git(dir, argv, big = false) {
  const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8', maxBuffer: big ? 512 * 1024 * 1024 : 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Tracked + untracked-not-ignored files of a working tree. */
export function treeFiles(dir) {
  const r = git(dir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return r.out.split('\0').filter(Boolean);
}

export function scanTree(dir, P, where = 'tree') {
  const findings = [];
  const files = treeFiles(dir);
  let scanned = 0;
  for (const f of files) {
    if (P.ignore.some((rx) => rx.test(f))) continue;
    const abs = join(dir, f);
    let st; try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    scanned++;
    findings.push(...scanText(buf.toString('utf8'), f, P, where, { tree: relative(ROOT, dir) || '.' }));
  }
  return { findings, files: files.length, scanned };
}

export function scanStaged(dir, P) {
  const names = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).out.split('\0').filter(Boolean);
  const findings = [];
  for (const f of names) {
    if (P.ignore.some((rx) => rx.test(f))) continue;
    const blob = spawnSync('git', ['show', `:${f}`], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    if (blob.status !== 0 || isBinary(blob.stdout)) continue;
    findings.push(...scanText(blob.stdout.toString('utf8'), f, P, 'staged'));
  }
  return { findings, files: names.length };
}

/**
 * Every blob ever reachable from the given refs (default: --all), scanned once per blob and
 * attributed to the first commit that introduced it (oldest first), with the paths it lived at.
 */
export function scanHistory(dir, P, refs = ['--all']) {
  const log = git(dir, ['log', ...refs, '--reverse', '--format=%H %ct %s', '--name-status', '--diff-filter=AM', '--no-renames'], true).out;
  const seen = new Map(); // blob sha → finding count (skip repeats)
  const findings = [];
  let commit = null, when = null, subject = null, blobs = 0, commits = 0;
  const lines = log.split('\n');
  for (const l of lines) {
    const mc = l.match(/^([0-9a-f]{40}) (\d+) (.*)$/);
    if (mc) { commit = mc[1]; when = new Date(Number(mc[2]) * 1000).toISOString(); subject = mc[3]; commits++; continue; }
    const mf = l.match(/^[AM]\t(.+)$/);
    if (!mf || !commit) continue;
    const path = mf[1];
    if (P.ignore.some((rx) => rx.test(path))) continue;
    const rev = git(dir, ['rev-parse', `${commit}:${path}`]);
    if (!rev.ok) continue;
    const blob = rev.out.trim();
    if (seen.has(blob)) continue;
    seen.set(blob, 0);
    const content = spawnSync('git', ['cat-file', '-p', blob], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    if (content.status !== 0 || content.stdout.length > 8 * 1024 * 1024 || isBinary(content.stdout)) continue;
    blobs++;
    const f = scanText(content.stdout.toString('utf8'), path, P, 'history', { commit: commit.slice(0, 12), when, subject: subject.slice(0, 80), blob: blob.slice(0, 12) });
    seen.set(blob, f.length);
    findings.push(...f);
  }
  return { findings, commits, blobs };
}

/** Which findings are still in the current tree vs only in history (the same file+pattern). */
export function classify(findings, treeSet) {
  return findings.map((f) => ({ ...f, in_tree: treeSet.has(`${f.file}|${f.pattern}`) }));
}

export function summarize(findings) {
  const by = (k) => { const o = {}; for (const f of findings) o[f[k]] = (o[f[k]] ?? 0) + 1; return o; };
  return { total: findings.length, by_severity: by('severity'), by_pattern: by('pattern'), files: new Set(findings.map((f) => f.file)).size };
}

export function markdown(title, sections) {
  const out = [`# ${title}`, ''];
  for (const s of sections) {
    out.push(`## ${s.title}`, '');
    if (s.note) out.push(s.note, '');
    if (s.findings?.length) {
      out.push('| severity | pattern | file | line | match | where |', '|---|---|---|---|---|---|');
      const sorted = [...s.findings].sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
      for (const f of sorted.slice(0, s.limit ?? 400)) out.push(`| ${f.severity} | ${f.pattern} | ${f.file} | ${f.line} | \`${f.match}\` | ${f.where}${f.commit ? ' ' + f.commit : ''}${f.tree ? ' ' + f.tree : ''} |`);
      if (sorted.length > (s.limit ?? 400)) out.push(`| … | … | ${sorted.length - (s.limit ?? 400)} more | | | |`);
      out.push('');
    } else if (s.findings) out.push('_none_', '');
  }
  return out.join('\n');
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  const lines = readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).hash;
}

const failOn = SEV[flag('--fail-on', 'medium')] ?? 2;
const gate = (findings) => findings.filter((f) => SEV[f.severity] >= failOn);

if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith('scan.mjs')) {
  const P = loadPatterns();
  const jsonOut = flag('--json');
  const mdOut = flag('--md');
  try {
    if (cmd === 'fixture') {
      // §12 negative control: the fixture MUST trip the gate, or the gate is broken.
      const fx = join(HERE, 'fixtures', 'must-fail.txt');
      const f = scanText(readFileSync(fx, 'utf8'), relative(ROOT, fx), P, 'fixture');
      const g = gate(f);
      const trips = g.length >= 8 && ['critical', 'high', 'medium'].every((s) => g.some((x) => x.severity === s));
      // …and the tree/staged/history scans must skip the fixture itself (patterns.json ignore_paths),
      // or the negative control would fail every real scan. Both facts are asserted together.
      const excluded = P.ignore.some((rx) => rx.test(relative(ROOT, fx)));
      const ok = trips && excluded;
      const note = !trips ? 'THE GATE IS BROKEN: the must-fail fixture did not trip it' : !excluded ? 'THE GATE IS BROKEN: the fixture is not in ignore_paths, so every tree scan would fail on it' : 'the negative control trips the gate and is excluded from tree scans';
      console.log(JSON.stringify({ ok, fixture: relative(ROOT, fx), findings: f.length, gated: g.length, severities: summarize(g).by_severity, excluded_from_tree_scans: excluded, note }));
      process.exit(ok ? 0 : 1);
    }
    if (cmd === 'hook') {
      const hook = join(ROOT, '.git', 'hooks', 'pre-commit');
      const gitDir = git(ROOT, ['rev-parse', '--git-common-dir']).out.trim();
      const target = join(ROOT, gitDir, 'hooks', 'pre-commit');
      if (args.includes('install')) {
        mkdirSync(join(ROOT, gitDir, 'hooks'), { recursive: true });
        writeFileSync(target, `#!/bin/sh\n# timmy privacy gate (ORDER privacy-d5n9): a staged match blocks the commit\nexec node "$(git rev-parse --show-toplevel)/lanes/privacy/scan.mjs" scan --staged --fail-on medium\n`, { mode: 0o755 });
        console.log(JSON.stringify({ ok: true, installed: target }));
      } else {
        console.log(JSON.stringify({ installed: existsSync(target), path: target, note: existsSync(hook) ? 'per-worktree hook present' : 'shared hooks dir' }));
      }
      process.exit(0);
    }
    if (cmd === 'audit') {
      // every order worktree's tree + the shared full history
      const wts = git(ROOT, ['worktree', 'list', '--porcelain']).out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      const trees = [];
      const all = [];
      for (const wt of wts) { const r = scanTree(wt, P, 'tree'); trees.push({ tree: wt, ...summarize(r.findings), files: r.files, scanned: r.scanned }); all.push(...r.findings); }
      const hist = scanHistory(ROOT, P, ['--all']);
      const treeSet = new Set(all.map((f) => `${f.file}|${f.pattern}`));
      const histClassified = classify(hist.findings, treeSet);
      const report = { generated_at: new Date().toISOString(), patterns_sha256: P.sha256, trees, history: { commits: hist.commits, blobs: hist.blobs, ...summarize(hist.findings), only_in_history: histClassified.filter((f) => !f.in_tree).length }, findings: { tree: all, history: histClassified } };
      const md = markdown('privacy.audit — woodman33/timmy-tui', [
        { title: 'Working trees', note: trees.map((t) => `- ${t.tree}: ${t.total} findings in ${t.files} files (${t.scanned} text files scanned) — ${JSON.stringify(t.by_severity)}`).join('\n') },
        { title: 'History', note: `${hist.commits} commits, ${hist.blobs} distinct text blobs scanned; ${hist.findings.length} findings, ${report.history.only_in_history} of them only in history (no longer in any tree). By pattern: ${JSON.stringify(report.history.by_pattern)}` },
        { title: 'Findings in the working trees (gate: critical/high/medium)', findings: gate(all), limit: 600 },
        { title: 'Findings only in history (first commit that introduced each)', findings: gate(histClassified.filter((f) => !f.in_tree)), limit: 400 },
        { title: 'Review-tier findings (brand / media)', findings: [...all, ...histClassified].filter((f) => f.severity === 'review'), limit: 200 }
      ]);
      if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
      if (mdOut) writeFileSync(mdOut, md);
      const receipt = has('--no-seal') ? null : seal('privacy.audit', { order: 'privacy-d5n9', patterns_sha256: P.sha256, trees: trees.length, tree_findings: all.length, tree_critical: all.filter((f) => f.severity === 'critical').length, tree_high: all.filter((f) => f.severity === 'high').length, tree_medium: all.filter((f) => f.severity === 'medium').length, tree_review: all.filter((f) => f.severity === 'review').length, history_commits: hist.commits, history_blobs: hist.blobs, history_findings: hist.findings.length, history_only: report.history.only_in_history, history_critical: hist.findings.filter((f) => f.severity === 'critical').length, report_sha256: mdOut ? sha(md) : '', report: mdOut ? relative(ROOT, mdOut) : '', gitleaks: flag('--gitleaks', '') });
      console.log(JSON.stringify({ ok: true, trees, history: report.history, receipt, json: jsonOut, md: mdOut }, null, 1));
      process.exit(0);
    }
    // scan
    let result;
    if (has('--staged')) result = scanStaged(ROOT, P);
    else if (has('--history')) result = scanHistory(ROOT, P, flag('--ref') ? [flag('--ref')] : ['--all']);
    else result = scanTree(resolve(flag('--tree', ROOT)), P);
    const g = gate(result.findings);
    const out = { ok: g.length === 0, ...summarize(result.findings), gated: g.length, fail_on: flag('--fail-on', 'medium'), patterns_sha256: P.sha256, findings: has('--quiet') ? undefined : result.findings.slice(0, 2000) };
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...out, findings: result.findings }, null, 1));
    if (mdOut) writeFileSync(mdOut, markdown('privacy.scan', [{ title: 'Findings', findings: result.findings }]));
    if (!has('--quiet') && !jsonOut) console.log(JSON.stringify(out, null, 1)); else console.log(JSON.stringify({ ...out, findings: undefined }));
    if (g.length) { console.error(`[privacy] BLOCKED: ${g.length} finding(s) at or above ${flag('--fail-on', 'medium')}; see the report`); process.exit(1); }
  } catch (e) {
    console.error(`[privacy] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
