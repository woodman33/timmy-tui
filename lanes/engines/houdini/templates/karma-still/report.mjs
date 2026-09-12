#!/usr/bin/env node
// Houdini · karma-still, step 3: node report.mjs <out dir> <stem>
// Verifies the PNG husk wrote (IHDR size must match the authored resolution), pulls
// the render timing out of the lane's render.log, and completes <stem>.karma.json.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, stem] = process.argv.slice(2);
const reportPath = join(out, `${stem}.karma.json`);
const pngPath = join(out, `${stem}.karma.png`);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const fail = (msg) => { report.render_ok = false; report.render_error = msg; writeFileSync(reportPath, JSON.stringify(report, null, 1)); console.error(msg); process.exit(1); };

if (!existsSync(pngPath)) fail(`missing ${pngPath}`);
const buf = readFileSync(pngPath);
if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') fail(`${pngPath} is not a PNG`);
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
const log = existsSync(join(out, 'render.log')) ? readFileSync(join(out, 'render.log'), 'utf8') : '';
const wall = log.match(/Total Wall Clock Time:\s*([\d:.]+)/);
const cpu = log.match(/Total CPU Time:\s*([\d:.]+)/);
const complete = /Render complete/.test(log);
report.png = { file: `${stem}.karma.png`, bytes: statSync(pngPath).size, width, height };
report.husk = { wall: wall ? wall[1] : null, cpu: cpu ? cpu[1] : null, render_complete: complete };
const [rw, rh] = report.resolution;
if (width !== rw || height !== rh) fail(`PNG is ${width}x${height}, expected ${rw}x${rh}`);
report.render_ok = true;
writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ok: true, png: report.png, husk: report.husk }));
