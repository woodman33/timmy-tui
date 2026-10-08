// The release artifact check (scripts/release/validate-tarball.mjs): the workflow packs one tarball,
// this check validates it, and publication uses that same file. Negative controls first (§12).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tldraw = readFileSync('companion/studio-canvas/LICENSE-tldraw.md');
const rrsb = readFileSync('companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE');

type Tree = Record<string, string | Buffer>;
function good(): Tree {
  return {
    'package/package.json': JSON.stringify({ name: 'timmy-tui', version: '9.9.9-rc.1', bin: { timmy: 'dist/timmy.js', 'timmy-tui': 'dist/timmy.js' } }),
    'package/dist/timmy.js': '#!/usr/bin/env node\n',
    'package/dist/src/cli.js': 'export {};\n',
    'package/companion/studio-canvas/dist/canvas.js': 'export {};\n',
    'package/companion/studio-canvas/dist/canvas.css': '',
    'package/companion/studio-canvas/dist/THIRD-PARTY-NOTICES.md': '# notices\n',
    'package/companion/studio-canvas/dist/versions.json': JSON.stringify({ tldraw: '5.5.2', distributable: true, missing: [] }),
    'package/companion/studio-canvas/dist/LICENSE-tldraw.md': tldraw,
    'package/companion/studio-canvas/LICENSE-tldraw.md': tldraw,
    'package/companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE': rrsb,
  };
}
function tarball(tree: Tree): string {
  const d = mkdtempSync(join(tmpdir(), 'release-'));
  for (const [p, c] of Object.entries(tree)) {
    mkdirSync(dirname(join(d, 'src', p)), { recursive: true });
    writeFileSync(join(d, 'src', p), c);
  }
  const out = join(d, 'timmy-tui-9.9.9-rc.1.tgz');
  const r = spawnSync('tar', ['-czf', out, '-C', join(d, 'src'), 'package']);
  expect(r.status).toBe(0);
  return out;
}
const without = (tree: Tree, path: string) => { const t = { ...tree }; delete t[path]; return t; };

describe('release artifact check', () => {
  it('negative control: a tarball without the canvas bundle fails, naming it', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    const r = validateTarball(tarball(without(good(), 'package/companion/studio-canvas/dist/canvas.js')));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/companion\/studio-canvas\/dist\/canvas\.js/);
  });

  it('negative control: a canvas build marked not distributable fails', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    const t = good();
    t['package/companion/studio-canvas/dist/versions.json'] = JSON.stringify({ distributable: false, missing: ['LICENSE-tldraw.md'] });
    const r = validateTarball(tarball(t));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/not distributable/);
  });

  it('negative control: an altered tldraw license fails, by its pinned hash', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    const t = good();
    t['package/companion/studio-canvas/dist/LICENSE-tldraw.md'] = Buffer.concat([tldraw, Buffer.from(' ')]);
    const r = validateTarball(tarball(t));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/LICENSE-tldraw\.md/);
  });

  it('negative control: a license text that is not the repository\'s committed bytes fails', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    const t = good();
    t['package/companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE'] = Buffer.concat([rrsb, Buffer.from('\n')]);
    const r = validateTarball(tarball(t));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/react-remove-scroll-bar\.LICENSE/);
  });

  it('negative control: files that must never ship fail the check', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    for (const path of ['package/tests/x.test.ts', 'package/.timmy/private/fleet.json', 'package/docs/ui-cockpit/c17/results.json', 'package/.env', 'package/node_modules/x/index.js']) {
      const r = validateTarball(tarball({ ...good(), [path]: 'x' }));
      expect(r.ok, path).toBe(false);
      expect(r.failures.join('\n'), path).toContain(path.replace(/^package\//, ''));
    }
  });

  it('negative control: a version other than the expected one, or a missing bin target, fails', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    expect(validateTarball(tarball(good()), { expectVersion: '9.9.9-rc.2' }).failures.join('\n')).toMatch(/9\.9\.9-rc\.2/);
    const r = validateTarball(tarball(without(good(), 'package/dist/timmy.js')));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/dist\/timmy\.js/);
  });

  it('pins the react-remove-scroll-bar license by its hash, as the privacy exception does, and leaves no extraction behind', async () => {
    const { RRSB_LICENSE_SHA256, validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    expect(createHash('sha256').update(rrsb).digest('hex')).toBe(RRSB_LICENSE_SHA256);
    const patterns = JSON.parse(readFileSync('lanes/privacy/patterns.json', 'utf8')) as { exempt_blobs: Array<{ path: string; sha256: string }> };
    expect(patterns.exempt_blobs.find((b) => b.path.endsWith('react-remove-scroll-bar.LICENSE'))?.sha256).toBe(RRSB_LICENSE_SHA256);
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('timmy-release-')));
    validateTarball(tarball(good()));
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('timmy-release-') && !before.has(n))).toEqual([]);
  });

  it('pins the same tldraw license hash as the canvas build', async () => {
    const { TLDRAW_LICENSE_SHA256 } = await import('../scripts/release/validate-tarball.mjs');
    const build = await import('../scripts/canvas/build.mjs');
    expect(TLDRAW_LICENSE_SHA256).toBe(build.TLDRAW_LICENSE_SHA256);
    expect(createHash('sha256').update(tldraw).digest('hex')).toBe(TLDRAW_LICENSE_SHA256);
  });

  it('with --github, a passing artifact hands the job its SHA-256 and integrity and writes the summary; a failing one hands it neither', () => {
    const run = (file: string) => {
      const d = mkdtempSync(join(tmpdir(), 'release-gh-'));
      const out = join(d, 'output'), summary = join(d, 'summary');
      writeFileSync(out, ''); writeFileSync(summary, '');
      const r = spawnSync(process.execPath, ['scripts/release/validate-tarball.mjs', file, '--github'], {
        encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary } });
      return { status: r.status, output: readFileSync(out, 'utf8'), summary: readFileSync(summary, 'utf8') };
    };
    const file = tarball(good());
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    const ok = run(file);
    expect(ok.status).toBe(0);
    expect(ok.output).toContain(`sha256=${sha}\n`);
    expect(ok.output).toMatch(/^integrity=sha512-[A-Za-z0-9+/]+=*$/m);
    expect(ok.summary).toContain(sha);
    const bad = run(tarball(without(good(), 'package/companion/studio-canvas/dist/canvas.js')));
    expect(bad.status).toBe(1);
    expect(bad.output).not.toMatch(/sha256=|integrity=/);
    expect(bad.summary).toMatch(/companion\/studio-canvas\/dist\/canvas\.js/);
  });

  it('a well-formed tarball passes, and its manifest carries the full SHA-256 and npm integrity of those exact bytes', async () => {
    const { validateTarball } = await import('../scripts/release/validate-tarball.mjs');
    const file = tarball(good());
    const r = validateTarball(file, { expectVersion: '9.9.9-rc.1' });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    const bytes = readFileSync(file);
    expect(r.manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(r.manifest.integrity).toBe('sha512-' + createHash('sha512').update(bytes).digest('base64'));
    expect(r.manifest).toMatchObject({ name: 'timmy-tui', version: '9.9.9-rc.1', file: 'timmy-tui-9.9.9-rc.1.tgz', bytes: bytes.length, entries: 10 });
    expect(r.manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
