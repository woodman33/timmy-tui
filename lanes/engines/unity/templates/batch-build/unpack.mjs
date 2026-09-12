#!/usr/bin/env node
// Unity · batch-build, step 1: node unpack.mjs <drop.unity.zip> <out> <stem>
// Unzips the project into out/project and copies the template's Editor script
// (Assets/Editor/ShelfBuild.cs) in, so -executeMethod Shelf.Build.WebGL exists.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [drop, out] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const project = join(out, 'project');
mkdirSync(project, { recursive: true });
const r = spawnSync('/usr/bin/unzip', ['-q', '-o', drop, '-d', project], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
if (!existsSync(join(project, 'Assets')) || !existsSync(join(project, 'ProjectSettings'))) { console.error('zip must hold Assets/ and ProjectSettings/ at its root'); process.exit(1); }
mkdirSync(join(project, 'Assets', 'Editor'), { recursive: true });
cpSync(join(here, 'ShelfBuild.cs'), join(project, 'Assets', 'Editor', 'ShelfBuild.cs'));
console.log(JSON.stringify({ project, shelf_script: 'Assets/Editor/ShelfBuild.cs' }));
