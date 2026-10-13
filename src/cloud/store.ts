/**
 * Round R4 (helper H93): where Timmy Cloud's client keeps its two files, in this computer's Timmy home. It ships in the npm
 * package, so it holds no agency credential and never will: the agency credential lives only in the trusted backend
 * (services/cloud, which never ships). What the client keeps is the backend's address, the PATH of the operator's token file
 * (never the token), and the backend's last answer:
 *
 *   <Timmy home>/cloud/            0700
 *     config.json                  0600  the backend's address and the token file's path (timmy cloud use)
 *     overview.json                0600  the backend's last answer to GET /v1/operator/overview and GET /v1/operator/orders,
 *                                        with when it was read, and the newest attempt since that did not read (timmy cloud status)
 *
 * Every write goes through a temp file and a rename (src/connect/store.ts writePrivate). God's Eye View reads both files
 * synchronously and never calls the network (readCloudFiles).
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { privateDir, writePrivate } from '../connect/store.js';
import { timmyHome } from '../utils/init.js';

export const CLOUD_CONFIG_SCHEMA = 'timmy.cloud.client/1';
export const CLOUD_CACHE_SCHEMA = 'timmy.cloud.cache/1';
/** The largest cache file God's Eye View reads (and the largest answer the client keeps). */
export const CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface CloudPaths { home: string; dir: string; config: string; cache: string }

export function cloudPaths(home: string = timmyHome()): CloudPaths {
  const h = path.resolve(home);
  const dir = path.join(h, 'cloud');
  return { home: h, dir, config: path.join(dir, 'config.json'), cache: path.join(dir, 'overview.json') };
}

export interface CloudConfig {
  schema: typeof CLOUD_CONFIG_SCHEMA;
  /** the backend's address: http://127.0.0.1:<port> (or another loopback name), or https://… */
  url: string;
  /** the operator's token file, absolute; the token itself is never copied here */
  token_file: string;
  set_at: string;
}

export interface CloudCache {
  schema: typeof CLOUD_CACHE_SCHEMA;
  /** the backend the answer came from */
  backend: string;
  /** when the answer below was read; null: never read */
  read_at: string | null;
  /** GET /v1/operator/overview, as the backend answered it */
  overview: unknown;
  /** GET /v1/operator/orders, as the backend answered it; null when it was not read (orders_why says why) */
  orders: unknown;
  orders_why?: string;
  /** the newest attempt after read_at that did not read, and why */
  failed?: { at: string; why: string };
}

/** A file of the client's: absent (null), or its JSON, or why it cannot be read as one. */
type FileRead = { state: 'absent' } | { state: 'read'; json: Record<string, unknown> } | { state: 'unreadable'; why: string };

function readJsonFile(file: string, max: number): FileRead {
  let size: number;
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return { state: 'unreadable', why: 'it is a symbolic link (the client writes its files in place)' };
    if (!st.isFile()) return { state: 'unreadable', why: 'it is not a regular file' };
    size = st.size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', why: `it cannot be read (${code ?? 'error'})` };
  }
  if (size > max) return { state: 'unreadable', why: `it is larger than ${Math.round(max / 1024 / 1024)} MB` };
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return { state: 'unreadable', why: `it cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { state: 'unreadable', why: 'it is not JSON' }; }
  return json && typeof json === 'object' && !Array.isArray(json) ? { state: 'read', json: json as Record<string, unknown> } : { state: 'unreadable', why: 'it is not a JSON object' };
}

export type ConfigRead = { state: 'absent' } | { state: 'read'; config: CloudConfig } | { state: 'unreadable'; why: string };

export function readConfig(p: CloudPaths): ConfigRead {
  const r = readJsonFile(p.config, 64 * 1024);
  if (r.state !== 'read') return r;
  const j = r.json;
  if (j.schema !== CLOUD_CONFIG_SCHEMA) return { state: 'unreadable', why: `its schema is not ${CLOUD_CONFIG_SCHEMA}` };
  if (typeof j.url !== 'string' || typeof j.token_file !== 'string' || !path.isAbsolute(j.token_file)) return { state: 'unreadable', why: 'it does not name a backend address and an absolute token file' };
  return { state: 'read', config: { schema: CLOUD_CONFIG_SCHEMA, url: j.url, token_file: j.token_file, set_at: typeof j.set_at === 'string' ? j.set_at : '' } };
}

export function writeConfig(p: CloudPaths, c: Omit<CloudConfig, 'schema'>): void {
  privateDir(p.dir);
  writePrivate(p.config, `${JSON.stringify({ schema: CLOUD_CONFIG_SCHEMA, ...c }, null, 2)}\n`);
}

export type CacheRead = { state: 'absent' } | { state: 'read'; cache: CloudCache } | { state: 'unreadable'; why: string };

export function readCache(p: CloudPaths): CacheRead {
  const r = readJsonFile(p.cache, CACHE_MAX_BYTES);
  if (r.state !== 'read') return r;
  const j = r.json;
  if (j.schema !== CLOUD_CACHE_SCHEMA) return { state: 'unreadable', why: `its schema is not ${CLOUD_CACHE_SCHEMA}` };
  if (typeof j.backend !== 'string') return { state: 'unreadable', why: 'it does not name the backend its answer came from' };
  const readAt = typeof j.read_at === 'string' && !Number.isNaN(Date.parse(j.read_at)) ? j.read_at : null;
  const failed = j.failed && typeof j.failed === 'object' && typeof (j.failed as Record<string, unknown>).at === 'string' && typeof (j.failed as Record<string, unknown>).why === 'string'
    ? { at: (j.failed as Record<string, string>).at, why: (j.failed as Record<string, string>).why } : undefined;
  return {
    state: 'read',
    cache: {
      schema: CLOUD_CACHE_SCHEMA, backend: j.backend, read_at: readAt, overview: readAt ? j.overview ?? null : null, orders: readAt ? j.orders ?? null : null,
      ...(typeof j.orders_why === 'string' ? { orders_why: j.orders_why } : {}), ...(failed ? { failed } : {}),
    },
  };
}

export function writeCache(p: CloudPaths, text: string): void {
  privateDir(p.dir);
  writePrivate(p.cache, text);
}
