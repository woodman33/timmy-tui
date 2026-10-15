/**
 * Round R4 (H121): the Cloudroom Core backend for Timmy's fleet — one self-hosted Core that the workers share (each a
 * session on a shared machine, never a VM), or the in-process FAKE Core for offline use (a simulation, labelled FAKE).
 *
 * Wiring is the lead's (src/fleet/service.ts is not changed here):
 *   const opened = await openCloudroomBackend(process.env);  // reads the flag and the config; in fake mode starts the
 *                                                            // FAKE Core; reads readiness and capabilities
 *   if (opened.ok) the service's backendFor('cloudroom') returns opened.backend (one per process, like the FAKE backend)
 * capabilities() on both seams is synchronous, so refresh() must have run before a plan is checked; until then the
 * runtime says it is unavailable and why.
 */
import type { Backend, RuntimeCapabilities } from '../backend.js';
import { CloudroomClient, type TokenSource } from './client.js';
import { cloudroomAvailability, DEFAULT_LABEL, DEFAULT_MAX_CONCURRENT, loadCloudroomSettings, readTokenFile, timmyHomeOf, type CloudroomMode } from './config.js';
import { FAKE_CORE_LABEL, startFakeCore, type FakeCore, type FakeCoreOptions } from './fake-core.js';
import { SharedCoreProvisioner } from './provisioner.js';
import { CloudroomRuntime } from './runtime.js';

export interface CloudroomBackend extends Backend {
  provisioner: SharedCoreProvisioner;
  runtime: CloudroomRuntime;
  mode: 'real' | 'fake';
  label: string;
  /** Reads GET /v1/ready and GET /v1/capabilities, so the synchronous capabilities() calls can answer. */
  refresh(signal?: AbortSignal): Promise<{ ready: boolean; why?: string; runtime: RuntimeCapabilities }>;
  /** Stops the in-process FAKE Core (fake mode). A real Core is never stopped. */
  shutdown(): Promise<void>;
}

export interface CloudroomBackendOptions {
  url: string;
  /** The token, or a function that reads it at each request (the real config reads its 0600 file only then). */
  token: TokenSource;
  mode: 'real' | 'fake';
  /** The config's label for the Core (default "cloudroom-core"; "fake-core" in fake mode). */
  name?: string;
  maxConcurrent?: number;
  timeoutMs?: number;
  tries?: number;
  retryDelayMs?: number;
  closeWaitMs?: number;
  /** In fake mode, the FAKE Core this backend talks to; shutdown() closes it. */
  fake?: FakeCore;
}

/** What Timmy shows beside the provider: FAKE for the FAKE Core; "not verified" for a real one until a live check passes. */
export const cloudroomLabel = (mode: 'real' | 'fake', name: string): string =>
  (mode === 'fake' ? FAKE_CORE_LABEL : `Cloudroom Core "${name}" (self-hosted, a session on a shared machine per worker; not verified)`);

export function cloudroomBackend(opts: CloudroomBackendOptions): CloudroomBackend {
  const name = opts.name ?? (opts.mode === 'fake' ? 'fake-core' : DEFAULT_LABEL);
  const label = cloudroomLabel(opts.mode, name);
  const client = new CloudroomClient({ url: opts.url, token: opts.token, timeoutMs: opts.timeoutMs });
  const provisioner = new SharedCoreProvisioner({ client, name, label, maxConcurrent: opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, tries: opts.tries, retryDelayMs: opts.retryDelayMs });
  const runtime = new CloudroomRuntime({ client, label, mode: opts.mode, tries: opts.tries, retryDelayMs: opts.retryDelayMs, closeWaitMs: opts.closeWaitMs });
  return {
    provisioner,
    runtime,
    mode: opts.mode,
    label,
    async refresh(signal) {
      const ready = await provisioner.readiness();
      const caps = await runtime.refresh(signal);
      return ready.ready ? { ready: true, runtime: caps } : { ready: false, why: ready.why, runtime: caps };
    },
    async shutdown() {
      await opts.fake?.close();
    },
  };
}

/**
 * The backend the flag and config ask for, ready to use (refreshed), or why there is none. In fake mode this starts a
 * FAKE Core in this process (call shutdown() when done). In real mode it reads the config, checks the token file's mode
 * and asks the Core whether it is ready and what it offers; the token itself is read only when a request is made.
 */
export async function openCloudroomBackend(env: Record<string, string | undefined> = process.env, home: string = timmyHomeOf(env), fakeOptions?: FakeCoreOptions):
  Promise<{ ok: true; backend: CloudroomBackend; ready: boolean; why?: string } | { ok: false; mode: CloudroomMode; why: string }> {
  const availability = cloudroomAvailability(env, home);
  if (!availability.available) return { ok: false, mode: availability.mode, why: availability.why };
  if (availability.mode === 'fake') {
    const fake = await startFakeCore(fakeOptions);
    const backend = cloudroomBackend({ url: fake.url, token: fake.token, mode: 'fake', fake });
    const r = await backend.refresh();
    return { ok: true, backend, ready: r.ready, ...(r.why ? { why: r.why } : {}) };
  }
  const s = loadCloudroomSettings(home);
  if (!s.ok) return { ok: false, mode: 'real', why: s.why };
  const tokenFile = s.settings.tokenFile;
  const backend = cloudroomBackend({ url: s.settings.url, token: () => readTokenFile(tokenFile), mode: 'real', name: s.settings.label, maxConcurrent: s.settings.maxConcurrent });
  const r = await backend.refresh();
  return { ok: true, backend, ready: r.ready, ...(r.why ? { why: r.why } : {}) };
}

export { cloudroomAvailability, cloudroomConfigPath, CLOUDROOM_FLAG, DEFAULT_MAX_CONCURRENT, readTokenFile, tokenFileProblem, writeCloudroomConfig } from './config.js';
export type { CloudroomFileConfig, CloudroomMode, CloudroomSettings } from './config.js';
export { FAKE_CORE_LABEL, startFakeCore } from './fake-core.js';
export type { FakeCore, FakeCoreOptions, FakeSessionFaults } from './fake-core.js';
export { CHILD_REFUSAL, UNKNOWN_REASON, cloudroomRequestId, nativeEventOf, promptIdFor, sessionIdFor } from './runtime.js';
export { CloudroomRuntime } from './runtime.js';
export { SharedCoreProvisioner } from './provisioner.js';
