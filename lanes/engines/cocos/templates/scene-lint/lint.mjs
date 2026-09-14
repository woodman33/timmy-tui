#!/usr/bin/env node
// Cocos Creator · scene-lint, step 3: node lint.mjs <project dir> <out dir> <stem>
// Scans assets/**/*.scene for referenced asset UUIDs ("__uuid__") and checks each
// against the library the --import step wrote (library/<uuid[0:2]>/<uuid>.*).
// Exit 1 when any reference is missing. Runs on any Node; needs no editor.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const [project, out, stem] = process.argv.slice(2);
const assets = join(project, 'assets');
const library = join(project, 'library');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const scenes = walk(assets).filter((p) => p.endsWith('.scene'));
const libHas = (uuid) => existsSync(join(library, uuid.slice(0, 2))) && readdirSync(join(library, uuid.slice(0, 2))).some((n) => n.startsWith(uuid));
const report = { kind: 'cocos.scene-lint', project: relative(out, project), library_present: existsSync(library), scenes: [], scene_count: scenes.length, missing: 0 };
for (const s of scenes) {
  const text = readFileSync(s, 'utf8');
  const uuids = [...new Set([...text.matchAll(/"__uuid__"\s*:\s*"([0-9a-fA-F-]{36}|[0-9a-zA-Z@_-]{22,})"/g)].map((m) => m[1].split('@')[0]))];
  const missing = report.library_present ? uuids.filter((u) => !libHas(u)) : uuids;
  report.missing += missing.length;
  report.scenes.push({ scene: relative(assets, s), references: uuids.length, missing: missing.length, missing_uuids: missing.slice(0, 20) });
}
writeFileSync(join(out, `${stem}.lint.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ scenes: report.scene_count, missing: report.missing, library_present: report.library_present }));
process.exit(report.missing ? 1 : 0);
