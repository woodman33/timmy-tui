import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import * as opencode from './adapters/opencode.js';
import * as hermes from './adapters/hermes.js';
import * as jcode from './adapters/jcode.js';
import * as pi from './adapters/pi.js';
import * as minds from './adapters/minds.js';

// CONTROL PLANE (ORDER control-plane-k3e7) — harness model policy. Timmy's model
// policy is translated to each tool's config/env at spawn. Dispatch receipts
// carry harness_model + harness_version (env-lock); tools that cannot be
// pointed at OpenRouter record their own model with source=harness-config.
export interface Adapter {
  name: string;
  canOpenRouter(): boolean;
  spawnArgs(modelId: string): string[];
  spawnEnv(): Record<string, string>;
  readConfigModel(): string | null;
}
export const ADAPTERS: Adapter[] = [opencode, hermes, jcode, pi, minds];
export const adapterFor = (harness: string): Adapter | undefined => ADAPTERS.find(a => a.name === harness);

export interface ModelPolicy { default: string | null; scopes: Record<string, string> }
export const policyPath = (dir: string = process.cwd()): string => join(dir, '.timmy', 'model-policy.json');

export function readPolicy(dir?: string): ModelPolicy {
  const p = policyPath(dir);
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as ModelPolicy; } catch { /* none */ }
  return { default: null, scopes: {} };
}
export function writePolicy(pol: ModelPolicy, dir?: string): void {
  const p = policyPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(pol, null, 2), 'utf8');
}
export function setModel(id: string, scope: string | null, dir?: string): ModelPolicy {
  const pol = readPolicy(dir);
  if (scope) pol.scopes[scope] = id; else pol.default = id;
  writePolicy(pol, dir);
  return pol;
}
export const modelFor = (harness: string, dir?: string): string | null => {
  const pol = readPolicy(dir);
  return pol.scopes[`harness:${harness}`] ?? pol.default;
};

const versionCache: Record<string, string> = {};
export function harnessVersion(harness: string): string {
  if (versionCache[harness]) return versionCache[harness];
  try { versionCache[harness] = execSync(`${harness} --version`, { encoding: 'utf8', timeout: 4000 }).trim().split('\n')[0]; }
  catch { versionCache[harness] = 'unknown'; }
  return versionCache[harness];
}

// fields for the dispatch receipt
export function harnessFields(harness: string, dir?: string): { harness_model: string; harness_version: string; model_source: string } {
  const a = adapterFor(harness);
  const want = modelFor(harness, dir);
  if (!a) return { harness_model: want ?? 'unspecified', harness_version: harnessVersion(harness), model_source: 'harness-config' };
  if (a.canOpenRouter() && want && process.env.OPENROUTER_API_KEY) return { harness_model: want, harness_version: harnessVersion(harness), model_source: 'openrouter' };
  return { harness_model: a.readConfigModel() ?? want ?? 'unspecified', harness_version: harnessVersion(harness), model_source: 'harness-config' };
}
