// R4 (H87), in a real PTY: the monitor (`timmy watch`, cli.tsx) asks nothing of a model when it starts, on the first-run
// screen or the shell; the operator's own check (`/model test` in the shell's chat) sends exactly one request; with no model
// key, the check sends nothing and the words say there is no model key.
//
// The model's upstream is a FAKE: an HTTP server of this test on 127.0.0.1 that records each request and answers as
// OpenRouter would; the monitor is pointed at it with TIMMY_MODEL_CHECK_URL (honoured only for 127.0.0.1). The key is a
// FAKE string. Nothing leaves this machine.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LOADER, MONITOR, monitorHome, type HomeKind } from './fixtures/ui-monitor-home.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FAKE upstream: records each request (method, path, whether it carried a key) and answers as OpenRouter would. */
async function fakeUpstream(): Promise<{ server: Server; url: string; seen: Array<{ method: string; path: string; key: boolean }> }> {
  const seen: Array<{ method: string; path: string; key: boolean }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({ method: req.method ?? '', path: req.url ?? '', key: /^Bearer sk-or-FAKE/.test(String(req.headers.authorization ?? '')) });
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ provider: 'FAKE-upstream', choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, seen };
}

// R11 (H169, Phase 0 item 1): there is no shipped default model: a check of the OpenRouter route needs a chosen model
// (OPENROUTER_MODEL here, as a person's choice for one process); with none, the chat refuses and `/model test` sends nothing
async function monitor(kind: HomeKind, key: string, model = '') {
  const up = await fakeUpstream();
  const h = monitorHome(kind, { git: true });
  // R4 (H103): the monitor's chat follows the setup's chat answer (`timmy init --yes` preselects the local model, which has
  // no model chosen here): these tests are of the OpenRouter route, so the setup says OpenRouter
  const setup = join(h.env.TIMMY_HOME!, 'setup.json');
  if (existsSync(setup)) {
    const s = JSON.parse(readFileSync(setup, 'utf8'));
    writeFileSync(setup, JSON.stringify({ ...s, answers: { ...s.answers, chat: 'openrouter' } }));
  }
  const env = `OPENROUTER_API_KEY='${key}' TIMMY_MODEL_CHECK_URL='${up.url}'${model ? ` OPENROUTER_MODEL='${model}'` : ''}`;
  h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '140', '-y', '40', '-c', h.repo, 'bash', '--norc', '-c',
    `${env} ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion; echo EXIT=$?; sleep 60`);
  return {
    h, up,
    async close() { up.server.close(); await h.dispose(); },
    /** Opens the shell's chat and types a line into it. */
    async chat(line: string) {
      h.tmux('send-keys', '-t', 't', 'c');
      await h.waitFor(/SOVEREIGN CHAT/, 10_000);
      h.tmux('send-keys', '-t', 't', '-l', line);
      await sleep(300);
      h.tmux('send-keys', '-t', 't', 'Enter');
    },
  };
}

describe('the monitor and the model, in a PTY (R4 H87)', () => {
  it('starting, the first-run screen and the shell send nothing to the model; the chat says the provider is not checked', async () => {
    for (const kind of ['first-run', 'initialized'] as const) {
      const m = await monitor(kind, 'sk-or-FAKE-key', 'fake/chosen-model');
      try {
        await m.h.waitFor(kind === 'first-run' ? /TIMMY · FIRST RUN/ : /YOUR JOURNEY/);
        await sleep(3000);
        expect({ kind, requests: m.up.seen.length }).toEqual({ kind, requests: 0 });
        if (kind === 'initialized') {
          m.h.tmux('send-keys', '-t', 't', 'c');
          await m.h.waitFor(/Provider: not checked\. `\/model test` checks it/, 10_000);
          expect(m.up.seen.length).toBe(0);
        }
      } finally {
        await m.close();
      }
    }
  }, 180_000);

  it('`/model test` in the chat sends exactly one request (to the FAKE, with the key, naming the chosen model) and shows what came back', async () => {
    const m = await monitor('initialized', 'sk-or-FAKE-key', 'fake/chosen-model');
    try {
      await m.h.waitFor(/YOUR JOURNEY/);
      await m.chat('/model test');
      await m.h.waitFor(/Model check: FAKE-upstream answered/, 30_000);
      await sleep(500);
      expect(m.up.seen).toEqual([{ method: 'POST', path: '/v1/chat/completions', key: true }]);
    } finally {
      await m.close();
    }
  }, 120_000);

  it('R11 (H169): with a key and no model chosen, the chat says so and `/model test` sends nothing', async () => {
    const m = await monitor('initialized', 'sk-or-FAKE-key');
    try {
      await m.h.waitFor(/YOUR JOURNEY/);
      m.h.tmux('send-keys', '-t', 't', 'c');
      await m.h.waitFor(/No model chosen\. \/model <id> chooses one/, 10_000);
      m.h.tmux('send-keys', '-t', 't', '-l', '/model test');
      await sleep(300);
      m.h.tmux('send-keys', '-t', 't', 'Enter');
      await m.h.waitFor(/Model check failed: No model chosen, so nothing was sent/, 30_000);
      await sleep(500);
      expect(m.up.seen).toEqual([]);
    } finally {
      await m.close();
    }
  }, 120_000);

  it('with no model key, `/model test` sends nothing and says there is no model key', async () => {
    const m = await monitor('initialized', '');
    try {
      await m.h.waitFor(/YOUR JOURNEY/);
      m.h.tmux('send-keys', '-t', 't', 'c');
      await m.h.waitFor(/No model key: nothing is sent to a model/, 10_000);
      m.h.tmux('send-keys', '-t', 't', '-l', '/model test');
      await sleep(300);
      m.h.tmux('send-keys', '-t', 't', 'Enter');
      await m.h.waitFor(/Model check failed: No model key, so nothing was sent/, 30_000);
      await sleep(500);
      expect(m.up.seen).toEqual([]);
    } finally {
      await m.close();
    }
  }, 120_000);
});
