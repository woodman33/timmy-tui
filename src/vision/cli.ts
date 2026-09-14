import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getVisionStatus, runVisionInspection, listVisionEvents, listLearningCandidates } from './runtime.js';
import { loadVisionEnvironment, visionAsset } from './config.js';
import { getVisionCatalog } from './platform.js';
import { publicVisionEvent } from './presentation.js';

export async function runVisionCli(args: string[], options: { quiet?: boolean } = {}) {
  loadVisionEnvironment();
  const sub = args.find(a => !a.startsWith('-')) ?? 'open';
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  if ((args.includes('--help') || args.includes('-h')) && !['doctor', 'stream'].includes(sub)) {
    console.log('timmy vision [open|serve|status|catalog|doctor|events|learning|proof-ladder --help|stream --help|run --image PATH --model ID]'); return;
  }
  if (sub === 'proof-ladder') { const { runProofLadderCli } = await import('./proof-ladder-cli.js'); await runProofLadderCli(args.slice(1)); return; }
  if (sub === 'status') { print(await getVisionStatus()); return; }
  if (sub === 'catalog') { print(await getVisionCatalog()); return; }
  if (sub === 'events') { const result = listVisionEvents({ limit: 100 }); print({ ...result, events: result.events.map(publicVisionEvent) }); return; }
  if (sub === 'learning') { const result = listLearningCandidates({ limit: 100 }); print({ ...result, events: result.events.map(publicVisionEvent) }); return; }
  if (sub === 'doctor' || sub === 'stream') {
    const localPython = resolve('.timmy/venv-vision/bin/python');
    const script = sub === 'stream' ? 'scripts/vision-stream.py' : 'scripts/vision-doctor.py';
    const r = spawnSync(process.env.TIMMY_VISION_PYTHON || (existsSync(localPython) ? localPython : 'python3'), [visionAsset(script), ...args.slice(1)], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1; return;
  }
  if (sub === 'run') {
    const spec = flag('--spec');
    const result = await runVisionInspection({ imagePath: flag('--image'), modelId: flag('--model'),
      workspace: flag('--workspace'), workflowId: flag('--workflow'),
      ...(spec ? { specification: JSON.parse(readFileSync(spec, 'utf8')) } : {}) });
    print('event' in result && result.event ? { ...result, event: publicVisionEvent(result.event) } : result); return;
  }
  if (sub !== 'serve' && sub !== 'open') {
    console.log('timmy vision [open|serve|status|catalog|doctor|events|learning|proof-ladder --help|stream --help|run --image PATH --model ID]'); return;
  }
  const port = Number(flag('--port') || '4336');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535.');
  if (sub === 'serve') {
    const { startVisionServer } = await import('./server.js');
    await startVisionServer(port);
    console.log(`Timmy Vision: http://127.0.0.1:${port}`); return;
  }
  const url = `http://127.0.0.1:${port}`;
  let running = false;
  try { const r = await fetch(`${url}/api/vision/status`, { signal: AbortSignal.timeout(1000) }); running = r.ok && (r.headers.get('content-type') || '').includes('json'); } catch { /* launch */ }
  if (!running) {
    const source = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const compiled = fileURLToPath(new URL('../cli.js', import.meta.url));
    const child = spawn(process.execPath, existsSync(compiled) ? [compiled, 'vision', 'serve', '--port', String(port)] : ['--import', 'tsx', source, 'vision', 'serve', '--port', String(port)], { detached: true, stdio: 'ignore', cwd: process.cwd() });
    child.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 200));
      try { const response = await fetch(`${url}/api/vision/status`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { running = true; break; } } catch { /* startup pending */ }
    }
    if (!running) {
      if (options.quiet) throw new Error('Vision Studio could not start.');
      console.error('Timmy Vision could not start. Run timmy vision serve to see the startup error.'); process.exitCode = 1; return;
    }
  }
  if (!options.quiet) console.log(`Timmy Vision: ${url}`);
  if (!args.includes('--no-open')) {
    const open = (await import('open')).default; await open(url);
  }
}
