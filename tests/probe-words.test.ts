/**
 * Round R4 (helper H82; the review of 6fb765a..4338fdb, finding 2): the /tools probes say what they checked, no more.
 *
 * Ollama: the probe's states told apart (no answer, an answer that is not Ollama's, only cloud models, local models whose
 * /api/show check did not finish within the probe's 1.5 s), the row driven by the server's answer, and the ollama command's
 * absence said on its own (r22: a sandbox whose PATH had no ollama command was told "not installed" while Ollama answered
 * at 127.0.0.1:11434); the probe asks 127.0.0.1 by default. Docker: what docker info did ("did not finish within 8 s",
 * "exited 1: <its first error line>", "could not start"), an 8 s limit, and the probe awaited before the synchronous work
 * that let its timer run out while docker's answer waited unread.
 *
 * FAKE pieces, each labelled: a FAKE Ollama (a real HTTP server on 127.0.0.1 answering /api/tags and /api/show as Ollama
 * does, no model behind it); FAKE docker clients (small sh scripts that print what docker would, run as real child
 * processes). Everything else is real: liveDeps, capabilities(), probeOllama over HTTP, dockerSetup's child processes.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocalOllamaBaseUrl, probeOllama } from '../src/agent/providers.js';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { liveDeps } from '../src/capabilities/live.js';
import { ollamaStartStep } from '../src/capabilities/ollama-route.js';
import { causeLine, DOCKER_PROBE_MS, dockerSetup } from '../src/code-agents/openhands-run.js';
import { OPENHANDS_SDK } from '../src/code-agents/openhands.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };
const byId = (rows: CapabilityRow[]): Record<string, CapabilityRow> => Object.fromEntries(rows.map((r) => [r.id, r]));
const script = (dir: string, name: string, body: string): string => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
const LOCAL = { capabilities: ['completion'], details: { format: 'gguf', family: 'fake' }, model_info: { 'fake.context_length': 4096 } };

/** A FAKE Ollama on 127.0.0.1: /api/tags lists `models`; /api/show answers as a local completion model, or never (`show: 'hang'`);
 *  R4 (H88): a model named in `broken` answers /api/show without the completion capability (it does not pass the check). */
async function fakeOllama(o: { models?: string[]; show?: 'ok' | 'hang'; status?: number; broken?: string[] }): Promise<number> {
  const s = createServer((req, res) => {
    if (o.status) { res.writeHead(o.status); res.end('not here'); return; }
    if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: (o.models ?? []).map((name) => ({ name })) })); return; }
    if (req.url === '/api/show') {
      if (o.show === 'hang') return; // never answers: the probe's time runs out
      let body = '';
      req.setEncoding('utf8').on('data', (c: string) => { body += c; });
      req.on('end', () => {
        const model = (() => { try { return String((JSON.parse(body) as { model?: unknown }).model); } catch { return ''; } })();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o.broken?.includes(model) ? { ...LOCAL, capabilities: ['embedding'] } : LOCAL));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** /tools as a sandbox with this PATH sees it (liveDeps: no model key, so OpenRouter is not contacted; Timmy Canvas asked on a closed port). */
async function tools(path: string, env: Record<string, string> = {}): Promise<Record<string, CapabilityRow>> {
  const root = temp('h82-probe-project-');
  return byId(await capabilities(liveDeps({ env: { PATH: path, HOME: temp('h82-probe-home-'), TIMMY_STUDIO_URL: `http://127.0.0.1:${await closedPort()}`, ...env }, model: 'fake/chat-model (FAKE)', storeDir: root, projectRoot: root })));
}

describe('Ollama: the probe\'s states told apart; the row says what the server answered (FAKE Ollama over real HTTP)', () => {
  it('asks 127.0.0.1:11434 by default (localhost may be tried as ::1 first)', () => {
    const was = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST;
    try { expect(getLocalOllamaBaseUrl()).toBe('http://127.0.0.1:11434'); } finally { if (was !== undefined) process.env.OLLAMA_HOST = was; }
  });

  it('r22: the server answered and the ollama command is not on PATH: reachable, with what was asked, when and how many models; the command\'s absence said apart', async () => {
    const port = await fakeOllama({ models: ['qwen3:4b'] });
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    const r = await tools(temp('h82-bin-'));
    expect(r.ollama).toMatchObject({ rung: 'reachable', detail: '1 local model; the ollama command is not on PATH' });
    expect(r.ollama.ladder!.reachable).toMatchObject({ asked: `GET http://127.0.0.1:${port}/api/tags, then each local model's details`, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), answer: '1 local model passed its /api/show check (it lists 1 model)' });
    expect(r['spatial-review']).toMatchObject({ rung: 'reachable' });
  });

  it('only cloud models: Ollama answered, and no local model is there (needs setup: a local one), said so', async () => {
    const port = await fakeOllama({ models: ['glm-5.3:cloud', 'kimi-k2.7-code:cloud'] });
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    const r = await tools(temp('h82-bin-'));
    expect(r.ollama).toMatchObject({ rung: 'needs setup', detail: `Ollama answered at 127.0.0.1:${port}: it lists only 2 cloud models, which Timmy does not use as local ones; the ollama command is not on PATH`, setup: 'ollama pull <model> (a local model, not a cloud one)' });
    expect(r.ollama.notReached!.reachable).toMatch(new RegExp(`^asked GET http://127\\.0\\.0\\.1:${port}/api/tags, then each local model's details at \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC: it lists only 2 cloud models, which Timmy does not use as local ones$`));
  });

  it('local models whose /api/show check did not finish within 1.5 s: installed (found by its answer), never "not installed"', async () => {
    const port = await fakeOllama({ models: ['qwen3:4b', 'gemma3:1b', 'x:cloud'], show: 'hang' });
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    const p = await probeOllama(300);
    expect(p).toMatchObject({ ok: false, models: [], base: `http://127.0.0.1:${port}`, answer: { state: 'listed', listed: 3, cloud: 1, checked: 0, failed: 0, late: 2, deadlineMs: 300 } });
    const r = await tools(temp('h82-bin-'));
    expect(r.ollama).toMatchObject({ rung: 'installed', detail: `Ollama answered at 127.0.0.1:${port}: it lists 2 local models and 1 cloud model, which Timmy does not use as local ones; no model was checked within 1.5 s; the ollama command is not on PATH` });
  });

  it('nothing answers: needs setup with the ollama command or without it (R6, H140: the rung follows the HTTP answer, never the PATH); the step fits this computer', async () => {
    const port = await closedPort();
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    expect(await probeOllama()).toMatchObject({ ok: false, models: [], answer: { state: 'no answer', why: 'the connection failed (ECONNREFUSED)' } });
    // no program: this platform's install (Homebrew only on macOS), never "installed"
    const bare = (await tools(temp('h82-bin-'))).ollama;
    expect(bare).toMatchObject({ rung: 'needs setup', detail: `the ollama command is not on PATH, and nothing answered at 127.0.0.1:${port} (the connection failed (ECONNREFUSED))`, setup: ollamaStartStep({ cli: false, platform: process.platform }) });
    if (process.platform !== 'darwin') expect(bare.setup).not.toMatch(/brew/);
    // the program on PATH (a FAKE that is never run) and nothing answering: still needs setup, its step `ollama serve`
    const bin = temp('h82-bin-');
    script(bin, 'ollama', 'echo "FAKE ollama: never run by /tools" >&2; exit 9');
    expect((await tools(bin)).ollama).toMatchObject({ rung: 'needs setup', detail: `nothing answered at 127.0.0.1:${port} (the connection failed (ECONNREFUSED))`, setup: 'ollama serve, then ollama pull <model>' });
  });

  it('R6 (H140): asks the address the chat asks (the chat setup\'s record), not OLLAMA_HOST\'s: a FAKE Ollama answering there is reachable with no ollama command on PATH', async () => {
    const port = await fakeOllama({ models: ['qwen3:8b'] });
    // OLLAMA_HOST names a port where nothing listens; the chat setup (FAKE record, as timmy init writes it) names the FAKE's
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${await closedPort()}`);
    const home = temp('h140-timmy-home-');
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'FAKE', chat: 'local', ollama: `http://127.0.0.1:${port}`, model: 'qwen3:8b' } }));
    const r = (await tools(temp('h140-bin-'), { TIMMY_HOME: home })).ollama;
    expect(r).toMatchObject({ rung: 'reachable', detail: '1 local model; the ollama command is not on PATH' });
    expect(r.setup).toBeUndefined();
    expect(r.ladder!.reachable).toMatchObject({ asked: `GET http://127.0.0.1:${port}/api/tags, then each local model's details`, answer: '1 local model passed its /api/show check (it lists 1 model)' });
    // nothing answering at the recorded address: the step names the setting that holds the address (the chat setup's)
    const gone = await closedPort();
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'FAKE', chat: 'local', ollama: `http://127.0.0.1:${gone}`, model: 'qwen3:8b' } }));
    const down = (await tools(temp('h140-bin-'), { TIMMY_HOME: home })).ollama;
    expect(down).toMatchObject({ rung: 'needs setup', detail: `the ollama command is not on PATH, and nothing answered at 127.0.0.1:${gone} (the connection failed (ECONNREFUSED))` });
  });

  it('R4 (H88; r23): OLLAMA_HOST=127.0.0.1:9: fetch refuses that port itself, so the request was not sent: said so (never "nothing answered"); a closed port still says nothing answered', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:9');
    // before: { state: 'no answer', why: 'the request failed' }, and the row "asked GET …/api/tags … nothing answered at 127.0.0.1:9"
    expect(await probeOllama()).toMatchObject({ ok: false, models: [], base: 'http://127.0.0.1:9', answer: { state: 'not sent', why: "Node's fetch refused it before it left this computer (bad port)" } });
    const r = (await tools(temp('h88-bin-'))).ollama;
    expect(r).toMatchObject({ rung: 'needs setup', detail: "the request to 127.0.0.1:9 was not sent: Node's fetch refused it before it left this computer (bad port); the ollama command is not on PATH", setup: 'set OLLAMA_HOST to the address Ollama listens on, such as 127.0.0.1:11434' });
    expect(r.notReached!.reachable).toMatch(/^not sent: GET http:\/\/127\.0\.0\.1:9\/api\/tags \(at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\), Node's fetch refused it before it left this computer \(bad port\)$/);
    expect(`${r.detail} ${r.notReached!.reachable}`).not.toMatch(/nothing answered|asked GET/);
    // a real closed port: the connection was tried and refused: nothing answered, as before
    const port = await closedPort();
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    expect(await probeOllama()).toMatchObject({ answer: { state: 'no answer', why: 'the connection failed (ECONNREFUSED)' } });
    expect((await tools(temp('h88-bin-'))).ollama.notReached!.reachable).toMatch(new RegExp(`^asked GET http://127\\.0\\.0\\.1:${port}/api/tags, then each local model's details at .+: nothing answered \\(the connection failed \\(ECONNREFUSED\\)\\)$`));
  });

  it('R4 (H88; r23): a local model that did not pass its /api/show check is counted in the row (r23: 9 listed, 8 passed, the 9th unmentioned)', async () => {
    const port = await fakeOllama({ models: ['qwen3:4b', 'gemma3:1b', 'broken:1b'], broken: ['broken:1b'] });
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    expect(await probeOllama()).toMatchObject({ ok: true, models: ['qwen3:4b', 'gemma3:1b'], answer: { state: 'listed', listed: 3, checked: 2, failed: 1, late: 0 } });
    const r = (await tools(temp('h88-bin-'))).ollama;
    expect(r).toMatchObject({ rung: 'reachable', detail: '2 local models; 1 more did not pass the /api/show check that establishes local completion weights; the ollama command is not on PATH' });
    expect(r.ladder!.reachable).toMatchObject({ answer: '2 local models passed their /api/show check; 1 more did not pass it (it lists 3 models)' });
  });

  it('something else answers (HTTP 404): not Ollama, said so', async () => {
    const port = await fakeOllama({ status: 404 });
    vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${port}`);
    expect((await tools(temp('h82-bin-'))).ollama).toMatchObject({ rung: 'needs setup', detail: `something answered at 127.0.0.1:${port}, but not as Ollama (HTTP 404); the ollama command is not on PATH` });
  });
});

describe('docker: what docker info did, within 8 s, never "the Docker daemon did not answer" for all of it (FAKE docker clients, real child processes)', () => {
  const ready = (dir: string, infoBody: string): string => script(dir, 'docker', [
    'case "$1" in',
    `  info) ${infoBody} ;;`,
    `  image) echo "sha256:${'ab'.repeat(32)}|${OPENHANDS_SDK}"; exit 0 ;;`,
    '  *) exit 64 ;;',
    'esac',
  ].join('\n'));

  it('a time limit, an exit with docker\'s own error, a client that is not there, an exit 0 naming no server: each in its own words', async () => {
    const bin = temp('h82-docker-');
    const slow = ready(bin, 'sleep 5; echo 29.4.0-fake');
    expect(await dockerSetup(slow, {}, 300)).toEqual({ state: 'no daemon', detail: 'docker info did not finish within 0.3 s' });
    const down = script(temp('h82-docker-'), 'docker', 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1');
    expect(await dockerSetup(down, {}, 5000)).toEqual({ state: 'no daemon', detail: 'docker info exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' });
    expect(await dockerSetup(join(temp('h82-docker-'), 'docker'), {}, 5000)).toEqual({ state: 'no daemon', detail: 'docker info could not start (ENOENT: no such program)' });
    const empty = ready(temp('h82-docker-'), 'exit 0');
    expect(await dockerSetup(empty, {}, 5000)).toEqual({ state: 'no daemon', detail: 'docker info exited 0 and named no Docker server' });
  }, 30_000);

  it('R4 (H88; r23): a line longer than 200 characters keeps its cause (its end) and marks the cut; a shorter one stays whole', async () => {
    // r23's shape (here with a socket path of no one's): the first 200 characters alone had ended at "…connect: ", unmarked
    const sock = '/var/folders/sandbox-for-timmy-tests/docker/run/no-such.sock';
    const line = `error during connect: Get "http://${encodeURIComponent(sock)}/v1.47/info": dial unix ${sock}: connect: no such file or directory`;
    expect(line.length).toBeGreaterThan(200);
    const down = script(temp('h88-docker-'), 'docker', `echo '${line}' >&2; exit 1`);
    const d = await dockerSetup(down, {}, 5000);
    expect(d.state).toBe('no daemon');
    const said = (d as { detail: string }).detail.replace(/^docker info exited 1: /, '');
    expect(said.length).toBe(200);
    expect(said).toContain('…');
    expect(said.endsWith(`dial unix ${sock}: connect: no such file or directory`)).toBe(true);
    expect(said.startsWith('error during connect: Get "http://')).toBe(true);
    expect(causeLine(`  ${'x'.repeat(199)}  \nsecond line`)).toBe('x'.repeat(199));
    expect(causeLine('')).toBe('');
  }, 30_000);

  it('/tools waits 8 s for docker info (it waited 4): a docker that answers after 4.5 s is checked; the row names what docker info did otherwise', async () => {
    expect(DOCKER_PROBE_MS).toBe(8000);
    // TIMMY_AGENT_DOCKER_BIN names the FAKE client (/tools finds docker on the sandbox's PATH, and runs the one it names)
    const bin = temp('h82-docker-');
    const slow = ready(bin, 'sleep 4.5; echo 29.4.0-fake; exit 0');
    const r = await tools(bin, { TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_DOCKER_BIN: slow });
    expect(r.openhands).toMatchObject({ rung: 'installed', detail: expect.stringContaining('implemented; not run: /agent openhands --local <task>') });
    const down = temp('h82-docker-');
    const refused = script(down, 'docker', 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1');
    const d = await tools(down, { TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_DOCKER_BIN: refused });
    expect(d.openhands).toMatchObject({ rung: 'needs setup', detail: 'docker info exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?; implemented; not run', setup: 'start your Docker engine (OrbStack, Docker or Rancher Desktop)' });
    // what the check ran, said beside its rung (never "runs no program")
    expect(d.openhands.notReached!.reachable).toBe('docker info (then, when it named a server, docker image inspect) ran for it, read-only: they show the Docker engine and its image, not OpenHands working; a run of its own exercises it');
  }, 60_000);

  it('an answer docker gave while Timmy was busy past the limit is read (execFile\'s own timer discarded it: "exited 0", nothing said)', async () => {
    const docker = ready(temp('h82-docker-'), 'echo 29.4.0-fake; exit 0');
    const busy = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* this process busy */ } };
    const checking = dockerSetup(docker, {}, 300);
    busy(1000);
    expect(await checking).toEqual({ state: 'ready', server: '29.4.0-fake', imageId: `sha256:${'ab'.repeat(32)}` });
  }, 30_000);

  it('the docker probe is awaited before the synchronous work: 1.2 s of it no longer runs out a 0.6 s docker check whose answer came at once', async () => {
    const bin = temp('h82-docker-');
    const docker = ready(bin, 'echo 29.4.0-fake; exit 0');
    const busy = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* the synchronous work: a chain's verification, say */ } };
    const deps: ProbeDeps = {
      env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, onPath: (b) => b === 'docker', canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
      ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
      lanes: () => [], adapters: () => [], receipts: () => { busy(1200); return { ok: true, count: 0 }; }, exercised: () => new Map(), edgeSet: () => false, exists: () => false,
      openhands: async () => ({ docker: await dockerSetup(docker, {}, 600), worker: true }),
    };
    const r = byId(await capabilities(deps));
    expect(r.openhands).toMatchObject({ rung: 'installed', detail: expect.stringContaining('implemented; not run: /agent openhands --local <task>') });
  }, 30_000);
});

describe('timmy tools --help says which program a check runs', () => {
  it('docker info and docker image inspect, when docker is on PATH; never "no program is run"', async () => {
    const { toolsHelp } = await import('../src/capabilities/cli.js');
    const help = toolsHelp();
    expect(help).not.toMatch(/no program is run/);
    expect(help).toContain('The one program run is docker, when it is\non PATH: docker info and docker image inspect, for OpenHands\' row (read-only; nothing is built or pulled).');
  });
});
