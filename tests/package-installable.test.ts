import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `npm install -g timmy-tui` resolves dependencies from the public npm registry only:
// this repo's .npmrc (which maps @jsr to npm.jsr.io) does not travel with the published
// package, so a runtime dependency that lives on JSR makes every install fail with E404.
const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const lock = read('package-lock.json');

describe('the published package installs from the public npm registry', () => {
  it('declares no runtime dependency that points at JSR', () => {
    const specs = Object.entries<string>({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(specs.filter(([name, spec]) => name.startsWith('@jsr/') || spec.includes('@jsr/'))).toEqual([]);
  });

  it('locks every runtime package to registry.npmjs.org', () => {
    const elsewhere = Object.entries<{ resolved?: string; version?: string; dev?: boolean }>(lock.packages)
      .filter(([path, entry]) => path && !entry.dev && entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/'))
      .map(([path, entry]) => `${path.replace(/^.*node_modules\//, '')}@${entry.version}`);
    expect(elsewhere).toEqual([]);
  });
});
