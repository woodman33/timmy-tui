#!/usr/bin/env node
// OpenRouter capability map (mindship-v5c2 step 1): every capability in
// capabilities.inventory.json (measured from the live docs) mapped to a
// command-center verb + a receipt kind, marked implemented / wire-now / later.
//
//   node fleet/openrouter/map.mjs [--no-seal]
//
// Rules are explicit per capability id (the table below); an id with no rule
// falls back to its area's default and is flagged `defaulted: true` so the
// map never quietly claims more than was decided. `implemented` names the
// file that does it today; `wire-now` names the surface a small change lands
// on; `later` says why it waits.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'fleet', 'openrouter');
const inv = JSON.parse(readFileSync(join(DIR, 'capabilities.inventory.json'), 'utf8'));
const invSha = createHash('sha256').update(readFileSync(join(DIR, 'capabilities.inventory.json'))).digest('hex');

const I = 'implemented', W = 'wire-now', L = 'later';
// id → [status, verb, receipt, where/how, note]
const RULES = {
  // models
  'models-list': [I, 'timmy models · timmy cf …/models', 'models.list', 'src/cli.ts models; workers/ai-proxy /models (slim id/ctx/price)', 'wire-now: seal the catalog sha so a model pin cites the catalog it came from'],
  'model-endpoints': [L, 'timmy models endpoints <id>', 'openrouter.endpoints', '', 'per-provider pricing/latency for a model; useful once routing is wired'],
  'models-user-filtered': [L, 'timmy models --mine', 'models.list', '', 'unverified in the docs'],
  'providers-list': [I, 'timmy commander providers · GET /providers', 'openrouter.providers', 'workers/ai-proxy/src/commander-core.ts providersList (live list + sha); lanes/commander/cli.mjs providers', 'src/agent/provider-registry.ts audit left to its owner; the live list is on the worker'],
  'latest-model-resolution': [L, 'timmy model ~author/family-latest', 'model.pin', '', 'allowlists pin exact ids on purpose; a floating alias needs the pinned id recorded in the receipt first'],
  'model-variant-suffixes': [I, 'timmy commander think --models a:nitro', 'commander.turn', 'workers/ai-proxy/src/tools.ts splitVariant/isAllowed', 'nitro · floor · free · online · thinking · exacto · beta · extended on an allowlisted base id'],
  // chat
  'chat-completions': [I, 'timmy commander think · timmy_llm_call · /chat', 'commander.turn · llm.call', 'workers/ai-proxy/src/commander-core.ts chatOnce; src/mcp/server.ts timmy_llm_call; worker /chat passthrough', ''],
  'prompt-completions': [L, '—', '—', '', 'legacy prompt field; nothing in Timmy needs it'],
  'anthropic-messages-api': [L, '—', '—', '', 'Timmy speaks chat completions; the Messages shape adds nothing yet'],
  // other
  'app-attribution-headers': [I, '(every call)', '—', 'workers/ai-proxy/src/tools.ts openrouterHeaders: HTTP-Referer + X-Title + X-OpenRouter-Categories on chatOnce, generateScript, openrouter_chat, /chat, /models; lanes/sim + lanes/swarm carry the same', ''],
  'presets': [L, 'timmy model @preset/<slug>', 'model.pin', '', 'project profiles already carry models; presets duplicate that server-side'],
  'batch-api': [L, 'timmy sim run --batch', 'sim.run', '', 'the story sim could batch actor turns at half price; after v0'],
  'openapi-and-versioning': [I, 'timmy oapi (spec_url openrouter.ai/openapi.json)', 'oapi.call', 'fleet/fleet.json openrouter-openapi (detect url = the spec) for src/mcp/server.ts timmy_oapi_run', 'the spec is on the fleet; the lane takes any spec_url'],
  'mcp-server': [I, 'fleet connector openrouter-mcp', 'fleet.detect', 'fleet/fleet.json openrouter-mcp (detect url https://mcp.openrouter.ai/mcp)', 'detect-only entry like tripo'],
  'ori-eval-llm-judge': [L, 'timmy judge', 'judge.run', '', 'Timmy has its own judge loop (timmy_judge_loop) with receipts'],
  'fusion-analyst-model-judge-alias': [L, '—', '—', '', 'a deprecated field alias, not a capability'],
  'broadcast-observability': [L, '(every call)', '—', '', 'trace/session ids to OpenRouter observability; receipts are our trace'],
  'workspaces-files-containers': [L, '—', '—', '', 'unverified'],
  'benchmarks-datasets-classifications': [L, 'timmy sim export', 'dataset.behavior-v0', '', 'unverified; behavior-v0 stays local'],
  // responses api
  'responses-api': [L, 'timmy commander think --api responses', 'commander.turn', '', 'commander uses chat completions; switch when server tools are wired'],
  'responses-tool-calling': [L, '—', 'commander.turn', '', 'with responses-api'],
  'responses-reasoning': [L, '—', 'commander.turn', '', 'with responses-api'],
  'responses-streaming': [L, '—', '—', '', 'with responses-api'],
  // streaming
  'sse-streaming': [I, 'timmy logs (companion) · timmy chat', 'chat.turn', 'src/companion/server.ts + client (stream: true); the TUI chat surface is Qwen-owned and not verified here', 'commander turns are non-streamed on purpose (one receipt per turn)'],
  'stream-cancellation': [I, 'timmy commander kill', 'commander.kill', 'workers/ai-proxy/src/commander.ts cmdKill: AbortController per in-flight call, aborted_inflight in the receipt', 'kill stops the current turn and swarm, not only the next'],
  'mid-stream-errors': [L, '—', '—', '', 'with streaming in the commander'],
  // tool calling
  'tool-calling': [I, 'timmy commander think --tools', 'commander.turn', 'commander-core.ts chatOnce tools[] + edgeToolRunner (one execution round over the edge tools; paid tools still need the approval token)', 'tool_calls recorded on the call'],
  'parallel-tool-calls': [L, '—', 'commander.turn', '', 'after tool-calling'],
  'server-tools': [L, 'timmy commander think --server-tools', 'commander.turn', '', 'server-side tools run at OpenRouter; receipts would cite their calls'],
  'server-tool-web-search': [L, 'timmy commander think --web', 'commander.turn', '', 'after server-tools'],
  'server-tool-web-fetch': [L, '—', 'commander.turn', '', 'after server-tools'],
  'server-tool-advisor': [L, '—', 'commander.turn', '', 'after server-tools'],
  'server-tool-subagent': [L, '—', 'commander.turn', '', 'Timmy dispatches harnesses itself (Command Post)'],
  'server-tool-fusion': [I, 'timmy commander think --mode fusion --native', 'commander.turn', 'commander-core.ts executeTurn native fusion → openrouter/fusion; receipt native=true', ''],
  'server-tools-shell-bash-apply-patch-tool-search': [L, '—', '—', '', 'unverified; Code Mode is the hands'],
  // structured outputs / plugins
  'structured-outputs': [I, 'timmy commander think --json-schema · timmy sim run', 'commander.turn · sim.turn · swarm.member', 'commander-core.ts chatOptionsFor response_format json_schema; swarm-core council/tournament json; lanes/sim/sim.mjs REFEREE_CONTRACT', ''],
  'response-healing-plugin': [I, 'timmy sim run', 'sim.turn', 'lanes/sim/sim.mjs REFEREE_CONTRACT plugins:[{id:\'response-healing\'}]', 'firstJson stays as the last resort'],
  'plugins-array': [I, 'timmy commander think --plugins', 'commander.turn', 'commander-core.ts chatBody plugins passthrough', ''],
  'web-search-plugin-online': [L, '—', '—', '', 'deprecated in favour of the web_search server tool'],
  'context-compression-middle-out': [L, 'timmy commander think', 'commander.turn', '', 'commander prompts are short; wire when memory grows into the prompt'],
  // routing
  'provider-order-and-fallbacks': [I, 'timmy commander think --provider', 'commander.turn', 'commander-core.ts chatBody provider passthrough; provider_used on every call record', ''],
  'provider-filters': [I, 'timmy commander think --provider', 'commander.turn', 'commander-core.ts chatBody provider passthrough (only/ignore/quantizations/require_parameters)', ''],
  'provider-sort-and-price-caps': [I, 'timmy commander cap --max-price', 'commander.cap · commander.turn', 'commander-core.ts applyCap max_price → provider.max_price on every call of the room', 'USD per million tokens'],
  'nitro-floor-shorthands': [I, 'timmy commander think --models a:floor', 'commander.turn', 'tools.ts splitVariant', 'with model-variant-suffixes'],
  'service-tier': [L, '—', 'commander.turn', '', 'no priority need yet'],
  'exacto-variant': [L, '—', '—', '', 'after tool-calling'],
  'auto-exacto': [L, '—', '—', '', 'after tool-calling'],
  'router-metadata': [I, '(every call)', 'commander.turn', 'tools.ts openrouterHeaders X-OpenRouter-Metadata: enabled; provider_used/model_used/generation_id in receipt.models[]', ''],
  'in-region-routing': [L, '—', '—', '', 'no residency requirement yet'],
  'model-fallbacks': [I, 'timmy commander think --models a,b', 'commander.turn', 'commander-core.ts planTurn generate: extra models → body.models fallbacks', ''],
  // auto routers
  'auto-router': [I, 'lane default openrouter/auto', 'agentrun', 'src/agent/lanes.ts (openhands LLM_MODEL default)', 'the commander allowlist pins ids; auto stays a lane default'],
  'pareto-code-router': [L, 'timmy commander think --models openrouter/pareto-code', 'commander.turn', '', 'after allowlist suffix/alias support'],
  'free-models-router': [I, 'timmy sim run --free', 'sim.turn', 'lanes/sim/sim.mjs --free → actor openrouter/free', 'a $0 actor tier for rehearsal runs'],
  'body-builder': [I, 'timmy commander think --mode bodybuilder --native', 'commander.turn', 'commander-core.ts native bodybuilder: openrouter/bodybuilder writes the requests, the commander runs the allowlisted ones (parseBodybuilder)', ''],
  'fusion-router': [I, 'timmy commander think --mode fusion --native', 'commander.turn', 'commander-core.ts native fusion → openrouter/fusion', ''],
  // caching
  'prompt-caching-cache-control': [L, '—', 'commander.turn', '', 'commander prompts are short; wire with memory-in-prompt'],
  'prompt-caching-automatic': [I, 'timmy commander spend', 'commander.turn', 'commander-core.ts usageCost tokens_cached → spend.tokens_cached', ''],
  'session-sticky-routing': [I, '(every commander call)', 'commander.turn', 'commander-core.ts chatOptionsFor session_id = commander:<room> (timmy:<room> on a Timmy)', ''],
  'response-caching': [L, '—', '—', '', 'unverified'],
  // multimodal
  'pdf-input-file-parser': [L, 'timmy commander think --file', 'commander.turn', '', 'after multimodal in the commander'],
  'image-input': [L, 'timmy commander think --image', 'commander.turn', '', 'the observer lane uses Roboflow for images today'],
  'audio-input-output': [L, '—', '—', '', ''],
  'video-input': [L, '—', '—', '', ''],
  'image-generation-api': [I, 'timmy gen', 'gen.run', 'src/utils/providers.ts (image models through OpenRouter) + GENS ledger', 'the dedicated /images endpoint is later; today images ride the chat route'],
  'video-generation-api': [I, 'timmy gen', 'gen.run', 'src/utils/providers.ts (happyhorse-1.1)', 'the dedicated /videos job endpoint is later'],
  'text-to-speech': [L, 'timmy gen --kind tts', 'gen.run', '', 'ElevenLabs lanes exist elsewhere'],
  'speech-to-text': [L, '—', '—', '', ''],
  // reasoning
  'reasoning-parameter': [I, 'timmy commander think --reasoning', 'commander.turn', 'commander-core.ts chatBody reasoning passthrough; tokens_reasoning in the ledger', ''],
  'reasoning-details-preservation': [L, '—', '—', '', 'multi-turn reasoning continuity; the commander keeps turns, not threads'],
  // usage
  'usage-object': [I, 'timmy commander spend', 'commander.turn', 'commander-core.ts usageCost/applySpend (cost, tokens, uncounted)', 'usage.include is deprecated per the docs (usage always returned): drop the flag'],
  'generation-stats': [I, 'timmy commander stats --turn|--id', 'commander.turn', 'commander.ts read stats → commander-core.ts generationStats (GET /generation?id); generation_id stored on every call', 'exact native cost per generation'],
  'zero-completion-insurance': [I, '(billing)', '—', 'automatic', 'nothing to wire'],
  'generation-feedback-and-stored-content': [L, '—', '—', '', 'unverified'],
  // privacy
  'zero-data-retention': [I, 'timmy project new --zdr · timmy commander think --zdr', 'project.new · commander.turn', 'lanes/project/templates/profile.cue routing.zdr; commander-core.ts chatBody provider.zdr', ''],
  'provider-logging-data-collection': [I, 'timmy project new --no-data-collection · think --no-data-collection', 'project.new · commander.turn', 'profile.cue routing.data_collection; chatBody provider.data_collection', ''],
  'input-output-logging': [L, '—', '—', '', 'dashboard toggle, not an API'],
  'guardrails': [L, 'timmy approve', 'approval', '', 'Timmy gates paid calls with its own single-use tokens'],
  // embeddings
  'embeddings-api': [L, '—', '—', '', 'CPO embeddings are local/Zilliz (Sparks plan)'],
  'rerank-api': [L, '—', '—', '', 'same'],
  // keys
  'bearer-api-key-auth': [I, '(every call)', '—', 'worker secret OPENROUTER_API_KEY; lanes read process.env', ''],
  'oauth-pkce': [L, 'timmy connect openrouter', 'connect', '', 'single-operator setup; env key suffices'],
  'workload-identity-federation': [L, '—', '—', '', 'unverified'],
  'management-api-keys': [I, 'timmy project new --budget', 'project.new', 'lanes/project/project.mjs mintProjectKey: POST /api/v1/keys limit = budget when OPENROUTER_PROVISIONING_KEY is set; recorded as not provisioned otherwise', 'the cap enforced by OpenRouter when a provisioning key exists'],
  'byok': [L, '—', '—', '', ''],
  'current-key-limits': [I, 'timmy cf pane', 'cf.pane', 'lanes/cf/pane.mjs spend.openrouter.key (/auth/key)', ''],
  // credits / limits / errors
  'credits': [I, 'timmy cf pane', 'cf.pane', 'lanes/cf/pane.mjs spend.openrouter.credits', ''],
  'analytics': [I, 'timmy cf pane', 'cf.pane', 'lanes/cf/pane.mjs openrouter activity source: GET /api/v1/activity (needs OPENROUTER_PROVISIONING_KEY; a dead source shows as dead)', ''],
  'rate-limits': [I, '/chat', '—', 'workers/ai-proxy/src/index.ts (429 passthrough + own RATE_LIMIT_PER_MIN)', ''],
  'error-shape-and-codes': [I, '(every call)', 'commander.turn.models[].error', 'index.ts preserves upstream status/body; commander records upstream errors per call', ''],
  // sdk
  'ts-sdk-package': [I, 'timmy chat / gen', '—', 'package.json @openrouter/sdk; src/agent/core.ts, src/agent/tools.ts, src/modes/chat/tools.ts', ''],
  'ts-sdk-chat-send': [I, 'timmy chat', 'chat.turn', 'src/agent/core.ts (the agent client)', ''],
  'ts-sdk-constructor-attribution': [W, '(sdk)', '—', 'src/agent/core.ts client construction', 'httpReferer/appTitle/appCategories on the client — src/agent is not on the swarm-b3k7 paths; the worker and every lane already carry attribution (see app-attribution-headers)'],
  'sdk-devtools': [L, '—', '—', '', 'unverified'],
  'agent-sdk-package': [L, '—', '—', '', '@openrouter/agent is not a dependency; the commander is the agent loop'],
  'agent-callmodel': [L, '—', '—', '', 'with agent-sdk-package'],
  'agent-tool-helper': [L, '—', '—', '', 'edge tools are zod already (tools.ts)'],
  'agent-stop-conditions': [L, '—', '—', '', 'the commander has cap + kill'],
  'agent-next-turn-params': [L, '—', '—', '', ''],
  'agent-dynamic-parameters': [L, '—', '—', '', ''],
  'agent-streaming-methods': [L, '—', '—', '', ''],
  'agent-message-format-converters': [L, '—', '—', '', ''],
  'agent-mcp-tools': [L, '—', '—', '', 'the commander handoff is the MCP surface'],
  'agent-lifecycle-hooks': [L, '—', '—', '', 'Timmy\'s pre-tool hook lives in the MCP server'],
  'agent-hitl-and-async-tools': [L, '—', '—', '', 'timmy approve is the HITL gate']
};

const AREA_DEFAULT = { verb: '—', receipt: '—', status: L, note: 'no rule written; defaulted' };

const rows = inv.capabilities.map((c) => {
  const r = RULES[c.id];
  const [status, verb, receipt, where, note] = r ?? [AREA_DEFAULT.status, AREA_DEFAULT.verb, AREA_DEFAULT.receipt, '', AREA_DEFAULT.note];
  return { id: c.id, area: c.area, name: c.name, status, verb, receipt, where, note, doc_url: c.doc_url, surface: c.request_surface ?? c.sdk_surface ?? null, unverified: !!c.unverified, defaulted: !r };
});

const count = (s) => rows.filter((r) => r.status === s).length;
const map = { v: 1, generated_at: new Date().toISOString(), inventory_sha256: invSha, inventory_sources: inv.sources.length, capabilities: rows.length, implemented: count(I), wire_now: count(W), later: count(L), defaulted: rows.filter((r) => r.defaulted).length, unverified: rows.filter((r) => r.unverified).length, not_found: inv.not_found, rows };
writeFileSync(join(DIR, 'capabilities.map.json'), JSON.stringify(map, null, 1));

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const md = [];
md.push('# OpenRouter capability map', '', `Generated ${map.generated_at} from \`capabilities.inventory.json\` (sha256 ${invSha.slice(0, 16)}, ${inv.sources.length} fetched sources, ${rows.length} capabilities). mindship-v5c2 step 1.`, '',
  `| status | count | meaning |`, `|---|---|---|`, `| implemented | ${map.implemented} | exists in the repo today; the row names the file |`, `| wire-now | ${map.wire_now} | a small change on a surface that already exists; the row names it |`, `| later | ${map.later} | waits; the row says why |`, '',
  `Unverified inventory entries: ${map.unverified}. Rows defaulted (no explicit rule): ${map.defaulted}. Not found in the docs: ${inv.not_found.map((n) => `\`${n.term}\``).join(', ') || 'none'}.`, '',
  '## Verbs and receipts', '', 'Command-center verbs are `timmy …` commands (src/cli.ts and the lanes it dispatches to); receipt kinds are the subjects sealed into the root store or the edge chains. `—` means no verb or receipt applies.', '');
for (const area of [...new Set(rows.map((r) => r.area))]) {
  md.push(`### ${area}`, '', '| capability | status | verb | receipt | where / how | note |', '|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.area === area)) md.push(`| [${esc(r.id)}](${r.doc_url ?? '#'})${r.unverified ? ' *(unverified)*' : ''} | **${r.status}** | ${esc(r.verb)} | ${esc(r.receipt)} | ${esc(r.where)} | ${esc(r.note)} |`);
  md.push('');
}
md.push('## The two names in the order', '', '- **bodybuilder** is real at OpenRouter: the `openrouter/bodybuilder` router returns `{requests:[…]}` for the caller to run in parallel. Timmy already fans out itself (commander `bodybuilder` mode, `timmy_judge_loop`); wiring the native router is a `--native` flag on the same mode.', '- **fusion** is real at OpenRouter: `openrouter/fusion` (a panel of models plus an analyst) and the `openrouter:fusion` server tool. Timmy runs its own actors + judge (commander `fusion` mode, `timmy_fusion_plan`); the native router is the `--native` alternative, and the receipt must say which one answered.', '- "judge" exists only as a deprecated alias (`judge_model` → `analyst_model`); "fan-out" is not an OpenRouter term.', '');
writeFileSync(join(DIR, 'CAPABILITY-MAP.md'), md.join('\n'));
const mapSha = createHash('sha256').update(readFileSync(join(DIR, 'capabilities.map.json'))).digest('hex');
console.log(JSON.stringify({ capabilities: rows.length, implemented: map.implemented, wire_now: map.wire_now, later: map.later, defaulted: map.defaulted, unverified: map.unverified, map_sha256: mapSha, files: ['fleet/openrouter/capabilities.map.json', 'fleet/openrouter/CAPABILITY-MAP.md'] }, null, 1));

if (!process.argv.includes('--no-seal')) {
  const a = ['tsx', 'src/cli.ts', 'seal', 'openrouter.map', '--meta', `capabilities=${rows.length}`, '--meta', `implemented=${map.implemented}`, '--meta', `wire_now=${map.wire_now}`, '--meta', `later=${map.later}`, '--meta', `unverified=${map.unverified}`, '--meta', `defaulted=${map.defaulted}`, '--meta', `inventory_sha256=${invSha}`, '--meta', `inventory_sources=${inv.sources.length}`, '--meta', `map_sha256=${mapSha}`, '--meta', 'map=fleet/openrouter/CAPABILITY-MAP.md', '--meta', `not_found=${inv.not_found.map((n) => n.term).join(',') || 'none'}`, '--meta', 'bodybuilder=openrouter/bodybuilder:real,wire-now', '--meta', 'fusion=openrouter/fusion+openrouter:fusion:real,wire-now', '--meta', 'order=mindship-v5c2'];
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(r.stdout ?? ''); if (r.status !== 0) process.stderr.write(r.stderr ?? '');
}
