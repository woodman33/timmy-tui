import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFal3dPlan, checkFal3dCredentials, collectFal3d, submitFal3dPlan, type Fal3dPlan } from './fal3d-adapter.js';

export async function runFal3dCli(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [command, target] = args;
  const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  let result: unknown;
  switch (command) {
    case 'check':
      result = await checkFal3dCredentials(env, args.includes('--live')); break;
    case 'plan': {
      if (!target) throw new Error('usage: timmy providers fal3d plan <batch.json> [--out <plan.json>]');
      const plan = buildFal3dPlan(JSON.parse(readFileSync(target, 'utf8')));
      const out = flag('--out');
      if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(plan, null, 2) + '\n'); }
      result = { ...plan, dry_run: true, generation_submitted: false,
        note: 'Inspect each image and estimate. Only the operator may run timmy approve <plan_hash> before submit.' }; break;
    }
    case 'submit':
      if (!target) throw new Error('usage: timmy providers fal3d submit <plan.json> --approval <operator-token>');
      result = await submitFal3dPlan(JSON.parse(readFileSync(target, 'utf8')) as Fal3dPlan, flag('--approval') ?? '', env); break;
    case 'status':
    case 'collect':
      if (!target) throw new Error('usage: timmy providers fal3d status|collect <plan_hash>');
      result = await collectFal3d(target, env, process.cwd(), command === 'collect'); break;
    default:
      throw new Error('usage: timmy providers fal3d check [--live] | plan <batch.json> [--out <plan.json>] | submit <plan.json> --approval <operator-token> | status|collect <plan_hash>');
  }
  console.log(JSON.stringify(result, null, 2));
}
