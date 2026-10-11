/**
 * R4 (H95): the companion's web code, built on this machine (scripts/companion-web-build.mjs): the browser companion's
 * STREAMDOWN CHAT island and the `timmy logs` chat mirror's, bundled with React, Streamdown 2.5.0, @streamdown/code 1.1.1
 * and @streamdown/mermaid 1.0.2 at the versions package.json pins; Streamdown's styles.css as it ships; the Tailwind classes
 * Streamdown emits, precompiled with tailwindcss 3.4.19 as the page configured the Play CDN; the page's three fonts (the
 * latin variable files of Outfit, Inter and Fira Code) each with its OFL-1.1 licence beside it; every bundled package's
 * licence in THIRD-PARTY-NOTICES.md. No WebAssembly (Shiki runs its JavaScript regex engine). CI has no build: this test
 * builds it first when it is missing or stale (one builder at a time).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTRIES, FONTS, TAILWIND_CONFIG, WEB_DIR, builtRecord, ensureCompanionWeb, inputsHash, packageCheck, versionProblems } from '../scripts/companion-web-build.mjs';

const root = process.cwd();
const dir = join(root, WEB_DIR);
const walk = (d: string, base = d): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)]; });

describe('the companion\'s web code, built from the installed packages (R4 H95)', () => {
  const temps: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
  beforeAll(async () => { await ensureCompanionWeb(); }, 600_000);
  afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

  it('holds both islands, built with the pinned versions, and can ship: every bundled package\'s licence in its notices', () => {
    const record = builtRecord(dir);
    expect(record).not.toBeNull();
    expect(record.versions).toMatchObject({ streamdown: '2.5.0', code: '1.1.1', mermaidPlugin: '1.0.2', tailwindcss: '3.4.19', esbuild: '0.28.0' });
    expect(record.versions.react).toBe(record.versions.reactDom);
    expect(record.entries).toEqual(Object.keys(ENTRIES).map((e) => `island/${e}.js`));
    for (const e of record.entries) expect(existsSync(join(dir, e)), e).toBe(true);
    expect(record.distributable).toBe(true);
    expect(record.missing).toEqual([]);
    expect(packageCheck(dir)).toEqual([]);
    const names = record.packages.map((p: { name: string }) => p.name);
    for (const n of ['react', 'react-dom', 'streamdown', '@streamdown/code', '@streamdown/mermaid', 'mermaid', 'shiki', 'dompurify']) expect(names, n).toContain(n);
    const notices = readFileSync(join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    for (const p of record.packages as Array<{ name: string; version: string }>) expect(notices, p.name).toContain(`## ${p.name} ${p.version}`);
    // fastdom (Mermaid's) ships no licence file: its README's License section, as it ships, is its text
    expect(notices).toMatch(/## fastdom [\d.]+\n\nLicense: MIT\n\n\(From the package's README, its License section: the package ships no licence file\.\)\n\n\(The MIT License\)/);
    // the build is the inputs it records
    expect(record.inputs).toBe(inputsHash(root));
  });

  it('ships the page\'s three fonts, the latin variable files only, each with its OFL-1.1 licence beside it, as the page\'s sheet names them', () => {
    const fonts = readdirSync(join(dir, 'fonts')).sort();
    expect(fonts).toEqual(FONTS.flatMap((f: { file: string; licence: string }) => [f.file, f.licence]).sort());
    const css = readFileSync(join(root, 'src', 'companion', 'client', 'companion.css'), 'utf8');
    for (const f of FONTS as Array<{ family: string; pkg: string; file: string; licence: string }>) {
      const pkg = join(root, 'node_modules', ...f.pkg.split('/'));
      expect(readFileSync(join(dir, 'fonts', f.file)).equals(readFileSync(join(pkg, 'files', f.file))), f.file).toBe(true);
      const licence = readFileSync(join(dir, 'fonts', f.licence), 'utf8');
      expect(licence, f.licence).toContain('SIL Open Font License, Version 1.1');
      expect(licence).toBe(readFileSync(join(pkg, 'LICENSE'), 'utf8'));
      // the page's sheet declares the family by the name it uses, from this file
      expect(css).toMatch(new RegExp(`font-family: '${f.family}';[^}]*src: url\\(/web/fonts/${f.file.replace(/[.]/g, '\\.')}\\) format\\('woff2-variations'\\)`));
    }
  });

  it('carries no WebAssembly: no .wasm file and no inlined module anywhere (Shiki\'s JavaScript regex engine highlights)', () => {
    const files = walk(dir);
    expect(files.filter((f) => f.endsWith('.wasm'))).toEqual([]);
    for (const f of files.filter((n) => n.endsWith('.js'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      // "\0asm", base64 or as bytes, is how an inlined WebAssembly module begins
      expect(/AGFzbQ|\b0,\s*97,\s*115,\s*109,\s*1,\s*0,\s*0,\s*0\b/.test(text), f).toBe(false);
    }
    // Shiki's own WebAssembly entry, left out of the build, answers with words if anything ever loaded it
    expect(files.some((f) => /^island\/chunks\/wasm-[\w-]+\.js$/.test(f) && readFileSync(join(dir, f), 'utf8').includes("Shiki's WebAssembly engine is not part of the companion's build"))).toBe(true);
  });

  it('compiles Tailwind as the page configured the Play CDN (preflight off, darkMode class); copies Streamdown\'s styles.css as it ships', () => {
    expect(TAILWIND_CONFIG).toEqual({ darkMode: 'class', corePlugins: { preflight: false } });
    const tw = readFileSync(join(dir, 'styles', 'tailwind.css'), 'utf8');
    // no preflight: none of its resets (it would set every element's border, margin and button look)
    expect(tw).not.toMatch(/border-width: 0;\s*\n\s*border-style: solid;|^button,\s*$|-webkit-text-size-adjust: 100%/m);
    // darkMode 'class': dark variants hang off a .dark ancestor (Tailwind 3.4 writes it :is(.dark *)), never a media query
    expect(tw).toMatch(/\.dark\\:text-[^{]*:is\(\.dark \*\) \{/);
    expect(tw).not.toMatch(/prefers-color-scheme/);
    // Streamdown's streaming caret, and classes its code highlighting and diagrams use
    expect(tw).toContain('--tw-content: var(--streamdown-caret)');
    expect(tw).toContain('.text-\\[var\\(--sdm-c\\2c inherit\\)\\]');
    expect(readFileSync(join(dir, 'styles', 'streamdown.css')).equals(readFileSync(join(root, 'node_modules', 'streamdown', 'styles.css')))).toBe(true);
  });

  it('is stale when an input changes, refuses versions other than the pinned ones, and a build that cannot ship is said to (negative controls)', () => {
    // a stand-in checkout with the build's own inputs: changing one island changes the hash
    const fake = temp('h95-inputs-');
    for (const f of [...Object.values(ENTRIES), 'src/companion/client/index.html', 'src/companion/client/companion.js']) {
      mkdirSync(join(fake, f, '..'), { recursive: true });
      copyFileSync(join(root, f), join(fake, f));
    }
    const before = inputsHash(fake);
    writeFileSync(join(fake, ENTRIES['companion-chat']), `${readFileSync(join(fake, ENTRIES['companion-chat']), 'utf8')}\n// changed\n`);
    expect(inputsHash(fake)).not.toBe(before);
    // pins it does not find installed stop the build before it writes
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'timmy-tui', devDependencies: { streamdown: '9.9.9' } }));
    const problems = versionProblems(fake);
    expect(problems.join('\n')).toMatch(/streamdown: package\.json pins 9\.9\.9, nothing is installed/);
    expect(problems.join('\n')).toMatch(/@streamdown\/code is not in package\.json/);
    // a build that says it cannot ship, a build missing an entry, and no build at all are each refused
    const bad = temp('h95-bad-');
    writeFileSync(join(bad, 'versions.json'), JSON.stringify({ ...builtRecord(dir), entries: [], distributable: false, missing: ['a package ships no licence text'] }));
    expect(packageCheck(bad)).toEqual(['a package ships no licence text']);
    expect(packageCheck(temp('h95-none-'))[0]).toMatch(/no build of the companion's web code here/);
  });
});
