// Higgsfield docs mirror: a versioned local copy of the endpoint catalog so
// prompts can be linted preflight against the REAL endpoint schema without a
// network call at generation time. The mirror lives at
// <store-root>/forge/docs-mirror.json, sibling of ledger.jsonl, refreshed by
// scripts/forge-docs-mirror.ts.
//
// Mirror schema (schema_version 1, defined here — the upstream docs have no
// single stable JSON contract, so the refresh script projects whatever it
// fetches into this shape):
//
//   {
//     schema_version: 1,
//     fetched_ts: string,             // ISO time the mirror was written
//     sources: string[],              // URLs the mirror was fetched from
//     doc_index?: string,             // raw docs index page (llms.txt), if fetched
//     endpoints: Record<string, EndpointConstraints>  // keyed by endpoint path,
//                                     // e.g. "/higgsfield-ai/dop/turbo"
//   }
//
//   EndpointConstraints {
//     method?: string;                // HTTP method (usually "post")
//     summary?: string;               // human description from the docs
//     operation_id?: string;
//     required?: string[];            // required input field names
//     params?: Record<string, MirrorParam>;  // per-field constraint entries:
//       { type?, default?, min?, max?, enum?: string[], required?, format?, title? }
//     enums?: Record<string, string[]>;      // denormalized enum choices,
//                                     // derived from params entries carrying
//                                     // `choices` or `enum` when not stored
//                                     // explicitly
//   }
//
// Tolerance contract: every entry point here fails SOFT. A missing mirror
// yields null / {} with a console.warn; a malformed-but-present mirror is
// warned about and treated as absent; an unknown endpoint yields {}. Nothing
// in this module throws on bad mirror content.
//
// Store-root resolution replicates ledger.ts exactly: TIMMY_STORE applies
// only when dir === cwd; explicit dirs resolve via rootStoreDir -> <dir>/.timmy.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootStoreDir } from '../../utils/receipts.js';

export interface MirrorParam {
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: string[];
  required?: boolean;
  format?: string;
  title?: string;
  [k: string]: unknown;
}

export interface EndpointConstraints {
  method?: string;
  summary?: string;
  operation_id?: string;
  required?: string[];
  params?: Record<string, MirrorParam>;
  enums?: Record<string, string[]>;
  [k: string]: unknown;
}

export interface DocsMirror {
  schema_version?: number;
  fetched_ts: string;
  sources: string[];
  doc_index?: string;
  endpoints: Record<string, EndpointConstraints>;
  [k: string]: unknown;
}

export function docsMirrorPath(dir: string): string {
  // same precedence as ledgerDir(): per-test TIMMY_STORE only when the caller
  // didn't pass an explicit dir; explicit dirs resolve via store-pin/legacy root
  if (process.env.TIMMY_STORE && dir === process.cwd()) return join(process.env.TIMMY_STORE, 'forge', 'docs-mirror.json');
  return join(rootStoreDir(dir) ?? join(dir, '.timmy'), 'forge', 'docs-mirror.json');
}

// null = absent (or unusable) mirror; never throws. A present-but-malformed
// file is warned about and treated the same as absent.
export function loadDocsMirror(dir = process.cwd()): DocsMirror | null {
  const p = docsMirrorPath(dir);
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`docs mirror at ${p} is not valid JSON (${(err as Error).message}); treating as absent`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`docs mirror at ${p} is not a JSON object; treating as absent`);
    return null;
  }
  const mirror = parsed as DocsMirror;
  if (!mirror.endpoints || typeof mirror.endpoints !== 'object' || Array.isArray(mirror.endpoints)) {
    console.warn(`docs mirror at ${p} has no endpoints map; endpoint lookups will return {}`);
    mirror.endpoints = {};
  }
  return mirror;
}

// {} for unknown/absent/malformed — never throws. Enums are taken from the
// stored `enums` map when present, otherwise derived from params entries that
// carry `choices` or `enum` arrays.
export function endpointConstraints(dir = process.cwd(), endpoint: string): EndpointConstraints {
  const mirror = loadDocsMirror(dir);
  if (!mirror) {
    console.warn(`docs mirror absent for ${endpoint}; skipping constraint lookup`);
    return {};
  }
  const entry = mirror.endpoints[endpoint];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const constraints = { ...entry } as EndpointConstraints;
  if (!constraints.enums && constraints.params) {
    const derived: Record<string, string[]> = {};
    for (const [name, param] of Object.entries(constraints.params)) {
      const choices = param?.enum ?? (param as { choices?: unknown } | undefined)?.choices;
      if (Array.isArray(choices) && choices.every(c => typeof c === 'string')) {
        derived[name] = choices as string[];
      }
    }
    if (Object.keys(derived).length > 0) constraints.enums = derived;
  }
  return constraints;
}
