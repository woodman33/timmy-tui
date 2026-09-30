// Refresh the Higgsfield docs mirror: fetches the endpoint catalog from the
// public Higgsfield docs and writes <store-root>/forge/docs-mirror.json
// (sibling of ledger.jsonl; store-root resolution via docsMirrorPath).
//
// Sources (public, unauthenticated — no HF credentials are ever read, sent,
// or logged here):
//   OPENAPI_URL   — https://docs.higgsfield.ai/docs/openapi.json
//                   machine-readable endpoint catalog; the AUTHORITATIVE source
//                   for params/enums projected into the mirror schema
//                   documented in src/forge/higgsfield/docs.ts
//   DOCS_INDEX_URL — https://docs.higgsfield.ai/docs/llms.txt
//                   docs page index, stored verbatim under `doc_index` so a
//                   future refresh can deepen the mirror per model page
//
// Fail-closed contract: EVERY source must fetch successfully before anything
// is written. An unreachable source, a non-2xx status, or unparseable
// OpenAPI JSON aborts with a clear error and exit 1 — no partial silent
// mirrors. Run: npx tsx scripts/forge-docs-mirror.ts
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsMirrorPath, type DocsMirror, type EndpointConstraints, type MirrorParam } from '../src/forge/higgsfield/docs.js';

const OPENAPI_URL = 'https://docs.higgsfield.ai/docs/openapi.json';
const DOCS_INDEX_URL = 'https://docs.higgsfield.ai/docs/llms.txt';
const SOURCES = [OPENAPI_URL, DOCS_INDEX_URL];
const FETCH_TIMEOUT_MS = 30_000;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: '*/*' },
  });
  if (!res.ok) throw new Error(`docs mirror source unreachable: ${url} (HTTP ${res.status})`);
  return res.text();
}

// Project an OpenAPI request-body property schema into a MirrorParam. Unknown
// fields pass through under `extra` so the mirror keeps anything the preflight
// linter might later want.
function projectParam(raw: Record<string, unknown>, required: boolean): MirrorParam {
  const param: MirrorParam = { required };
  if (typeof raw.type === 'string') param.type = raw.type;
  if ('default' in raw) param.default = raw.default;
  if (typeof raw.minimum === 'number') param.min = raw.minimum;
  if (typeof raw.maximum === 'number') param.max = raw.maximum;
  if (Array.isArray(raw.enum) && raw.enum.every(v => typeof v === 'string')) {
    param.enum = raw.enum as string[];
  }
  if (typeof raw.format === 'string') param.format = raw.format;
  if (typeof raw.title === 'string') param.title = raw.title;
  return param;
}

// Build the endpoints map from the OpenAPI paths object. Keys are endpoint
// paths as they appear in the OpenAPI (e.g. "/higgsfield-ai/dop/turbo");
// the generation adapter's endpoint ids match these without the leading
// slash (see src/forge/higgsfield/client.ts subscribe()).
function projectEndpoints(openapi: Record<string, unknown>): Record<string, EndpointConstraints> {
  const paths = openapi.paths;
  if (!paths || typeof paths !== 'object') throw new Error('openapi.json has no paths object');
  const endpoints: Record<string, EndpointConstraints> = {};
  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const op = (pathItem as Record<string, unknown>).post;
    if (!op || typeof op !== 'object') continue;
    const opObj = op as Record<string, unknown>;
    const entry: EndpointConstraints = { method: 'post' };
    if (typeof opObj.summary === 'string') entry.summary = opObj.summary;
    if (typeof opObj.operationId === 'string') entry.operation_id = opObj.operationId;

    const schema = (
      (opObj.requestBody as Record<string, unknown> | undefined)?.content as
        Record<string, { schema?: Record<string, unknown> }> | undefined
    )?.['application/json']?.schema;
    const properties = schema?.properties;
    if (properties && typeof properties === 'object') {
      const requiredList = Array.isArray(schema?.required) ? (schema!.required as unknown[]) : [];
      const params: Record<string, MirrorParam> = {};
      const enums: Record<string, string[]> = {};
      for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const param = projectParam(raw as Record<string, unknown>, requiredList.includes(name));
        params[name] = param;
        if (param.enum) enums[name] = param.enum;
      }
      entry.params = params;
      if (Object.keys(enums).length > 0) entry.enums = enums;
      entry.required = Object.keys(params).filter(n => params[n].required);
    } else {
      // Degradation tripwire: exactly one upstream POST is legitimately
      // bodyless today. If a future upstream refactor (e.g. $ref-based
      // requestBody schemas) silently degrades projection, this warn becomes
      // the alarm. Do NOT silence by building a $ref resolver here (deferred).
      console.warn(`docs mirror projection: POST ${path} has no application/json requestBody properties; endpoint stored without params`);
    }
    endpoints[path] = entry;
  }
  if (Object.keys(endpoints).length === 0) {
    throw new Error('openapi.json contained no POST endpoints; refusing to write an empty mirror');
  }
  return endpoints;
}

export async function refreshDocsMirror(dir = process.cwd()): Promise<string> {
  // Fetch ALL sources before writing anything — fail closed, no partial mirror.
  const [openapiText, docIndex] = await Promise.all(SOURCES.map(fetchText));
  let openapi: Record<string, unknown>;
  try {
    openapi = JSON.parse(openapiText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`openapi source returned invalid JSON (${(err as Error).message})`);
  }
  const mirror: DocsMirror = {
    schema_version: 1,
    fetched_ts: new Date().toISOString(),
    sources: SOURCES,
    doc_index: docIndex,
    endpoints: projectEndpoints(openapi),
  };
  const p = docsMirrorPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  // Atomic write: tmp file in the same dir, then rename over the target —
  // concurrent runs leave an intact file (last rename wins, no torn reads).
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(mirror, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
  return p;
}

async function main(): Promise<void> {
  const p = await refreshDocsMirror(process.cwd());
  console.log(`docs mirror refreshed: ${p}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err: unknown) => {
  // undici surfaces only "fetch failed"; the actionable cause (ENOTFOUND,
  // timeout, ...) lives on the cause chain — walk to the deepest message.
  let cause: unknown = err;
  while (cause && typeof cause === 'object' && 'cause' in cause && cause.cause) {
    cause = cause.cause;
  }
  const message = err instanceof Error ? err.message : String(err);
  const deep = cause instanceof Error && cause !== err ? cause.message : null;
  console.error(deep && deep !== message ? `${message} (caused by: ${deep})` : message);
  process.exitCode = 1;
});
