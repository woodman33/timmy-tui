// BOOT (opentui-u4e9): prebundle the TUI entry so boot.cjs skips tsx entirely.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/tui/fast-entry.tsx'],
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  external: ['fsevents', 'react-devtools-core', 'playwright-core', 'chromium-bidi', 'chromium-bidi/*'],
  alias: { 'react-devtools-core': './scripts/devtools-stub.js' },
  banner: { js: "import { createRequire as __timmyCR } from 'node:module'; const require = __timmyCR(import.meta.url);" },
  logLevel: 'warning',
});
console.log('built dist/cli.js');
