/**
 * R11 (H169, Phase 0 item 3): timmy_openhands_run's model call goes through the route policy like every other model call, and
 * the OpenRouter key never goes into a command line. Before, llm 'auto' shipped OPENROUTER_API_KEY and openrouter/auto to
 * the runner unchecked (free-only and local-only never saw it), and put the key on docker's argv (`-e LLM_API_KEY=sk-...`),
 * where every process list would show it.
 *
 * Now: llm 'auto' is openrouter/auto, a cloud route whose price is not known before the run, so local-only refuses it and
 * free-only refuses it, each in its own words, before docker is asked and before any workspace is made; a cloud-named local
 * model is refused under local-only too; with the policy off the run goes, and the key reaches docker through --env-file (a
 * 0600 file of the process's own, outside the workspace, removed when the runner exits), never on argv.
 *
 * FAKE pieces, labelled: the docker on the PATH (a shell script that records every command, reads the env file while it
 * stands and answers an envelope), the OpenRouter key (sk-or-FAKE-…). Nothing is run in a container, nothing leaves this
 * computer, no model is asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOpenHandsRoute, OH_RUNNER_IMAGE, openHandsPlanHash, openHandsRoute, OPENROUTER_AUTO, runOpenHandsTask } from '../src/utils/openhands-adapter.js';
import { readChain } from '../src/utils/receipts.js';

const KEY = 'sk-or-FAKE-openhands-route-policy-0001';
let dir = '';
let bin = '';
const calls = (): string[] => { try { return readFileSync(join(dir, 'docker-calls.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-oh-route-'));
  bin = join(dir, 'FAKE-bin');
  mkdirSync(bin);
  // FAKE docker: `info` and `image inspect` say yes; `run` records its argv, copies the env file it is given (cp -p: contents
  // and mode) while the file stands, reads its stdin, and answers the runner's envelope (host canary untouched, the patch
  // applied to the pristine clone, its acceptance green)
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${join(dir, 'docker-calls.txt')}"
case "$1" in
  info) exit 0 ;;
  image) exit 0 ;;
  run)
    envfile=""
    prev=""
    for a in "$@"; do if [ "$prev" = "--env-file" ]; then envfile="$a"; fi; prev="$a"; done
    if [ -n "$envfile" ]; then cp -p "$envfile" "${join(dir, 'env-file-copy.txt')}"; echo "$envfile" > "${join(dir, 'env-file-path.txt')}"; fi
    cat > "${join(dir, 'stdin.txt')}"
    # b56c36f0: the checks run inside the runner, so the FAKE envelope carries the workspace checks too
    echo '{"ok":true,"patch":"","host_canary":false,"patch_applied":true,"work_acceptance":[{"cmd":"true","code":0}],"pristine_acceptance":[{"cmd":"true","code":0}]}'
    exit 0 ;;
  *) echo "FAKE docker: $1 must not run" >&2; exit 97 ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('LLM_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const task = (o: Partial<Parameters<typeof runOpenHandsTask>[0]> = {}) => {
  const base = { task: 'FAKE: make the failing test pass', acceptance: ['true'], wall_ms: 60000, max_iterations: 1, dir, engine: 'docker' as const, ...o };
  return { ...base, preApproved: { plan_hash: openHandsPlanHash(base) } };
};

describe('the route a run takes, as the policy reads it', () => {
  it('llm local: the named model on this computer\'s Ollama (permitted by both rules); llm auto: openrouter/auto, a cloud route of unknown price', () => {
    expect(openHandsRoute({})).toEqual({ source: 'ollama-local', model: 'qwen3.8:27b-mlx', host: '127.0.0.1:11434', role: 'tool', tool: 'timmy_openhands_run' });
    expect(openHandsRoute({ llm: 'local', local_model: 'ollama/granite4.2:latest' }).model).toBe('granite4.2:latest');
    expect(openHandsRoute({ llm: 'auto' })).toEqual({ source: 'openrouter', model: OPENROUTER_AUTO, role: 'tool', tool: 'timmy_openhands_run' });
    for (const policy of [{ freeOnly: true, localOnly: false }, { freeOnly: false, localOnly: true }, { freeOnly: true, localOnly: true }]) {
      expect(checkOpenHandsRoute({}, policy)).toEqual({ ok: true });
      expect(checkOpenHandsRoute({ llm: 'auto' }, policy).ok).toBe(false);
    }
    expect(checkOpenHandsRoute({ llm: 'auto' }, { freeOnly: false, localOnly: false })).toEqual({ ok: true });
    // a cloud-named local model is refused under local-only (the Ollama would send it to Ollama's cloud)
    expect(checkOpenHandsRoute({ local_model: 'ollama/kimi-k2:cloud' }, { freeOnly: false, localOnly: true })).toMatchObject({ ok: false, reason: 'cloud-under-local-only' });
  });
});

describe('timmy_openhands_run under the route policy (a FAKE docker on the PATH)', () => {
  it('free-only on, llm auto: refused in free-only\'s words (unknown is never free) before docker is asked; the receipt says route_policy', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    const started = Date.now() - 1000;
    const r = await runOpenHandsTask(task({ llm: 'auto', max_spend: 1 }));
    expect(r).toMatchObject({ ok: false, state: 'blocked' });
    expect(r.note).toBe(`Free-only is on, so timmy_openhands_run did not run (it asks ${OPENROUTER_AUTO}): ${OPENROUTER_AUTO}'s price is not known (OpenRouter routes each request to a model of its own choosing, so no price is known before the run), and unknown is never free. Nothing was sent; permitted: a model known to be free (/model free lists the catalog's), or one on this computer's Ollama (no charge); free-only stays on.`);
    expect(calls()).toEqual([]);
    const last = readChain('runs', dir).at(-1) as { status: string; error_class: string; subject: string; discrepancies: string[] };
    expect(last).toMatchObject({ status: 'denied', error_class: 'route_policy', subject: 'openhands run DENIED (route policy)', discrepancies: [r.note] });
    expect(JSON.stringify(last)).not.toContain(KEY);
    // no env file folder was made (only this adapter makes timmy-oh-env-*)
    expect(readdirSync(tmpdir()).filter((n) => /^timmy-oh-env-[A-Za-z0-9]{6}$/.test(n) && statSync(join(tmpdir(), n)).mtimeMs >= started)).toEqual([]);
  });

  it('local-only on, llm auto: refused in local-only\'s words (a cloud route), nothing started; free-only and local-only both on: local-only speaks first', async () => {
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    const r = await runOpenHandsTask(task({ llm: 'auto', max_spend: 1 }));
    expect(r).toMatchObject({ ok: false, state: 'blocked' });
    expect(r.note).toBe(`Local-only is on, so timmy_openhands_run did not run (it asks ${OPENROUTER_AUTO}): OpenRouter (cloud) runs off this computer. Nothing was sent; permitted: a model with local weights on this computer's Ollama (/model lists them); local-only stays on.`);
    expect(calls()).toEqual([]);
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const both = await runOpenHandsTask(task({ llm: 'auto', max_spend: 1 }));
    expect(both.note).toMatch(/^Local-only is on, so timmy_openhands_run did not run \(it asks openrouter\/auto\): OpenRouter \(cloud\) runs off this computer\. Nothing was sent; permitted: .*; free-only is on too; local-only stays on\.$/);
    expect(calls()).toEqual([]);
  });

  it('local-only on, a cloud-named local model: refused too; the default local model passes the check (docker is asked)', async () => {
    vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '1');
    const cloud = await runOpenHandsTask(task({ local_model: 'ollama/kimi-k2:cloud' }));
    expect(cloud).toMatchObject({ ok: false, state: 'blocked' });
    expect(cloud.note).toMatch(/^Local-only is on, so timmy_openhands_run did not run \(it asks kimi-k2:cloud\): kimi-k2:cloud is a cloud model: the Ollama at 127\.0\.0\.1:11434 sends it to Ollama's cloud\./);
    expect(calls()).toEqual([]);
    const local = await runOpenHandsTask(task({}));
    expect(local.ok).toBe(true);
    expect(calls().slice(0, 2)).toEqual(['info', `image inspect ${OH_RUNNER_IMAGE}`]);
    expect(calls()[2]).toMatch(/^run /);
    // the local runner's env file names the local model and the placeholder key 'ollama' (no secret)
    expect(readFileSync(join(dir, 'env-file-copy.txt'), 'utf8')).toBe('LLM_MODEL=ollama/qwen3.8:27b-mlx\nLLM_API_KEY=ollama\nLLM_BASE_URL=http://host.docker.internal:11434\n');
  });

  it('policy off, llm auto with a FAKE key: the run goes; the key reaches docker through --env-file (0600, outside the workspace, gone after), never on argv', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    const r = await runOpenHandsTask(task({ llm: 'auto', max_spend: 1 }));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, host_canary: false, acceptance: [{ cmd: 'true', code: 0 }], pristine_acceptance: [{ cmd: 'true', code: 0 }] });
    const run = calls()[2];
    expect(run).toMatch(/^run --rm -i --cap-drop=ALL --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 --add-host host\.docker\.internal:host-gateway -v \S+:\/work --env-file \S+ timmy-oh-runner:1\.21\.0-attempts-1$/);
    expect(run).not.toContain(KEY);
    expect(run).not.toMatch(/LLM_API_KEY|-e /);
    // what the env file held while the runner ran: the three variables, the key among them; 0600; a folder of its own, not
    // the workspace; removed once the runner exited
    expect(readFileSync(join(dir, 'env-file-copy.txt'), 'utf8')).toBe(`LLM_MODEL=${OPENROUTER_AUTO}\nLLM_API_KEY=${KEY}\nLLM_BASE_URL=https://openrouter.ai/api/v1\n`);
    expect((statSync(join(dir, 'env-file-copy.txt')).mode & 0o777).toString(8)).toBe('600');
    const envFile = readFileSync(join(dir, 'env-file-path.txt'), 'utf8').trim();
    expect(envFile.startsWith(r.workdir!)).toBe(false);
    expect(envFile).toMatch(/timmy-oh-env-[A-Za-z0-9]{6}\/runner\.env$/);
    expect(existsSync(envFile)).toBe(false);
    // the runner was told its task on stdin, as before
    expect(JSON.parse(readFileSync(join(dir, 'stdin.txt'), 'utf8'))).toMatchObject({ task: 'FAKE: make the failing test pass', workspace: '/work', acceptance: ['true'] });
    // the receipts never hold the key
    expect(JSON.stringify(readChain('runs', dir))).not.toContain(KEY);
  });

  it('policy off, llm auto with no key anywhere: not configured, nothing started (docker is not asked)', async () => {
    const r = await runOpenHandsTask(task({ llm: 'auto', max_spend: 1 }));
    expect(r).toMatchObject({ ok: false, state: 'not_configured', note: 'llm=auto asks OpenRouter, and no key is set (OPENROUTER_API_KEY or LLM_API_KEY in this process\'s environment), so nothing was started' });
    expect(calls()).toEqual([]);
    expect((readChain('runs', dir).at(-1) as { error_class: string }).error_class).toBe('not_configured');
  });

  it('the spend guard still comes first: llm auto with no max_spend is refused for that, whatever the policy', async () => {
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const r = await runOpenHandsTask(task({ llm: 'auto' }));
    expect(r).toMatchObject({ ok: false, state: 'blocked', note: 'llm=auto requires max_spend > 0' });
    expect(calls()).toEqual([]);
  });
});
