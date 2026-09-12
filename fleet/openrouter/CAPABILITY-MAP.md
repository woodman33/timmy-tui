# OpenRouter capability map

Generated 2026-09-08T10:31:23.275Z from `capabilities.inventory.json` (sha256 862e9fd78d6e81f2, 111 fetched sources, 104 capabilities). mindship-v5c2 step 1.

| status | count | meaning |
|---|---|---|
| implemented | 43 | exists in the repo today; the row names the file |
| wire-now | 1 | a small change on a surface that already exists; the row names it |
| later | 60 | waits; the row says why |

Unverified inventory entries: 9. Rows defaulted (no explicit rule): 0. Not found in the docs: `fan-out`.

## Verbs and receipts

Command-center verbs are `timmy …` commands (src/cli.ts and the lanes it dispatches to); receipt kinds are the subjects sealed into the root store or the edge chains. `—` means no verb or receipt applies.

### models

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [models-list](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) | **implemented** | timmy models · timmy cf …/models | models.list | src/cli.ts models; workers/ai-proxy /models (slim id/ctx/price) | wire-now: seal the catalog sha so a model pin cites the catalog it came from |
| [model-endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model) | **later** | timmy models endpoints <id> | openrouter.endpoints |  | per-provider pricing/latency for a model; useful once routing is wired |
| [models-user-filtered](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails) *(unverified)* | **later** | timmy models --mine | models.list |  | unverified in the docs |
| [providers-list](https://openrouter.ai/docs/api/api-reference/providers/list-providers) | **implemented** | timmy commander providers · GET /providers | openrouter.providers | workers/ai-proxy/src/commander-core.ts providersList (live list + sha); lanes/commander/cli.mjs providers | src/agent/provider-registry.ts audit left to its owner; the live list is on the worker |
| [latest-model-resolution](https://openrouter.ai/docs/guides/routing/routers/latest-resolution) | **later** | timmy model ~author/family-latest | model.pin |  | allowlists pin exact ids on purpose; a floating alias needs the pinned id recorded in the receipt first |
| [model-variant-suffixes](https://openrouter.ai/docs/guides/routing/model-variants/free) | **implemented** | timmy commander think --models a:nitro | commander.turn | workers/ai-proxy/src/tools.ts splitVariant/isAllowed | nitro · floor · free · online · thinking · exacto · beta · extended on an allowlisted base id |

### chat

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [chat-completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request) | **implemented** | timmy commander think · timmy_llm_call · /chat | commander.turn · llm.call | workers/ai-proxy/src/commander-core.ts chatOnce; src/mcp/server.ts timmy_llm_call; worker /chat passthrough |  |
| [prompt-completions](https://openrouter.ai/docs/api_reference/overview) | **later** | — | — |  | legacy prompt field; nothing in Timmy needs it |
| [anthropic-messages-api](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message) | **later** | — | — |  | Timmy speaks chat completions; the Messages shape adds nothing yet |

### other

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [app-attribution-headers](https://openrouter.ai/docs/app-attribution) | **implemented** | (every call) | — | workers/ai-proxy/src/tools.ts openrouterHeaders: HTTP-Referer + X-Title + X-OpenRouter-Categories on chatOnce, generateScript, openrouter_chat, /chat, /models; lanes/sim + lanes/swarm carry the same |  |
| [presets](https://openrouter.ai/docs/guides/features/presets) | **later** | timmy model @preset/<slug> | model.pin |  | project profiles already carry models; presets duplicate that server-side |
| [batch-api](https://openrouter.ai/docs/batch-quickstart) | **later** | timmy sim run --batch | sim.run |  | the story sim could batch actor turns at half price; after v0 |
| [broadcast-observability](https://openrouter.ai/docs/guides/features/broadcast) | **later** | (every call) | — |  | trace/session ids to OpenRouter observability; receipts are our trace |
| [openapi-and-versioning](https://openrouter.ai/docs/api_reference/versioning) | **implemented** | timmy oapi (spec_url openrouter.ai/openapi.json) | oapi.call | fleet/fleet.json openrouter-openapi (detect url = the spec) for src/mcp/server.ts timmy_oapi_run | the spec is on the fleet; the lane takes any spec_url |
| [mcp-server](https://openrouter.ai/docs/guides/overview/mcp-server) | **implemented** | fleet connector openrouter-mcp | fleet.detect | fleet/fleet.json openrouter-mcp (detect url https://mcp.openrouter.ai/mcp) | detect-only entry like tripo |
| [ori-eval-llm-judge](https://openrouter.ai/docs/guides/ori/eval) | **later** | timmy judge | judge.run |  | Timmy has its own judge loop (timmy_judge_loop) with receipts |
| [fusion-analyst-model-judge-alias](https://openrouter.ai/docs/changelog) | **later** | — | — |  | a deprecated field alias, not a capability |
| [workspaces-files-containers](https://openrouter.ai/docs/guides/features/workspaces) *(unverified)* | **later** | — | — |  | unverified |
| [benchmarks-datasets-classifications](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks) *(unverified)* | **later** | timmy sim export | dataset.behavior-v0 |  | unverified; behavior-v0 stays local |

### responses-api

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [responses-api](https://openrouter.ai/docs/api_reference/responses/overview) | **later** | timmy commander think --api responses | commander.turn |  | commander uses chat completions; switch when server tools are wired |
| [responses-tool-calling](https://openrouter.ai/docs/api_reference/responses/tool-calling) | **later** | — | commander.turn |  | with responses-api |
| [responses-reasoning](https://openrouter.ai/docs/api_reference/responses/reasoning) | **later** | — | commander.turn |  | with responses-api |
| [responses-streaming](https://openrouter.ai/docs/api_reference/responses/basic-usage) | **later** | — | — |  | with responses-api |

### streaming

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [sse-streaming](https://openrouter.ai/docs/api_reference/streaming) | **implemented** | timmy logs (companion) · timmy chat | chat.turn | src/companion/server.ts + client (stream: true); the TUI chat surface is Qwen-owned and not verified here | commander turns are non-streamed on purpose (one receipt per turn) |
| [stream-cancellation](https://openrouter.ai/docs/api_reference/streaming) | **implemented** | timmy commander kill | commander.kill | workers/ai-proxy/src/commander.ts cmdKill: AbortController per in-flight call, aborted_inflight in the receipt | kill stops the current turn and swarm, not only the next |
| [mid-stream-errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) | **later** | — | — |  | with streaming in the commander |

### tool-calling

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [tool-calling](https://openrouter.ai/docs/guides/features/tool-calling) | **implemented** | timmy commander think --tools | commander.turn | commander-core.ts chatOnce tools[] + edgeToolRunner (one execution round over the edge tools; paid tools still need the approval token) | tool_calls recorded on the call |
| [parallel-tool-calls](https://openrouter.ai/docs/api_reference/parameters) | **later** | — | commander.turn |  | after tool-calling |
| [server-tools](https://openrouter.ai/docs/guides/features/server-tools) | **later** | timmy commander think --server-tools | commander.turn |  | server-side tools run at OpenRouter; receipts would cite their calls |
| [server-tool-web-search](https://openrouter.ai/docs/guides/features/server-tools/web-search) | **later** | timmy commander think --web | commander.turn |  | after server-tools |
| [server-tool-web-fetch](https://openrouter.ai/docs/guides/features/server-tools/web-fetch) | **later** | — | commander.turn |  | after server-tools |
| [server-tool-advisor](https://openrouter.ai/docs/guides/features/server-tools/advisor) | **later** | — | commander.turn |  | after server-tools |
| [server-tool-subagent](https://openrouter.ai/docs/guides/features/server-tools/subagent) | **later** | — | commander.turn |  | Timmy dispatches harnesses itself (Command Post) |
| [server-tool-fusion](https://openrouter.ai/docs/guides/features/server-tools/fusion) | **implemented** | timmy commander think --mode fusion --native | commander.turn | commander-core.ts executeTurn native fusion → openrouter/fusion; receipt native=true |  |
| [server-tools-shell-bash-apply-patch-tool-search](https://openrouter.ai/docs/guides/features/server-tools) *(unverified)* | **later** | — | — |  | unverified; Code Mode is the hands |

### structured-outputs

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [structured-outputs](https://openrouter.ai/docs/guides/features/structured-outputs) | **implemented** | timmy commander think --json-schema · timmy sim run | commander.turn · sim.turn · swarm.member | commander-core.ts chatOptionsFor response_format json_schema; swarm-core council/tournament json; lanes/sim/sim.mjs REFEREE_CONTRACT |  |

### plugins

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [response-healing-plugin](https://openrouter.ai/docs/guides/features/plugins/response-healing) | **implemented** | timmy sim run | sim.turn | lanes/sim/sim.mjs REFEREE_CONTRACT plugins:[{id:'response-healing'}] | firstJson stays as the last resort |
| [plugins-array](https://openrouter.ai/docs/guides/features/plugins) | **implemented** | timmy commander think --plugins | commander.turn | commander-core.ts chatBody plugins passthrough |  |
| [web-search-plugin-online](https://openrouter.ai/docs/guides/features/plugins/web-search) | **later** | — | — |  | deprecated in favour of the web_search server tool |

### routing

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [provider-order-and-fallbacks](https://openrouter.ai/docs/guides/routing/provider-selection) | **implemented** | timmy commander think --provider | commander.turn | commander-core.ts chatBody provider passthrough; provider_used on every call record |  |
| [provider-filters](https://openrouter.ai/docs/guides/routing/provider-selection) | **implemented** | timmy commander think --provider | commander.turn | commander-core.ts chatBody provider passthrough (only/ignore/quantizations/require_parameters) |  |
| [provider-sort-and-price-caps](https://openrouter.ai/docs/guides/routing/provider-selection) | **implemented** | timmy commander cap --max-price | commander.cap · commander.turn | commander-core.ts applyCap max_price → provider.max_price on every call of the room | USD per million tokens |
| [nitro-floor-shorthands](https://openrouter.ai/docs/guides/features/service-tiers) | **implemented** | timmy commander think --models a:floor | commander.turn | tools.ts splitVariant | with model-variant-suffixes |
| [service-tier](https://openrouter.ai/docs/guides/features/service-tiers) | **later** | — | commander.turn |  | no priority need yet |
| [exacto-variant](https://openrouter.ai/docs/guides/routing/model-variants/exacto) | **later** | — | — |  | after tool-calling |
| [auto-exacto](https://openrouter.ai/docs/guides/routing/auto-exacto) | **later** | — | — |  | after tool-calling |
| [router-metadata](https://openrouter.ai/docs/guides/features/router-metadata) | **implemented** | (every call) | commander.turn | tools.ts openrouterHeaders X-OpenRouter-Metadata: enabled; provider_used/model_used/generation_id in receipt.models[] |  |

### privacy

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [in-region-routing](https://openrouter.ai/docs/guides/features/in-region-routing) | **later** | — | — |  | no residency requirement yet |
| [zero-data-retention](https://openrouter.ai/docs/guides/features/zdr) | **implemented** | timmy project new --zdr · timmy commander think --zdr | project.new · commander.turn | lanes/project/templates/profile.cue routing.zdr; commander-core.ts chatBody provider.zdr |  |
| [provider-logging-data-collection](https://openrouter.ai/docs/guides/privacy/provider-logging) | **implemented** | timmy project new --no-data-collection · think --no-data-collection | project.new · commander.turn | profile.cue routing.data_collection; chatBody provider.data_collection |  |
| [input-output-logging](https://openrouter.ai/docs/guides/features/input-output-logging) | **later** | — | — |  | dashboard toggle, not an API |
| [guardrails](https://openrouter.ai/docs/guides/features/guardrails) | **later** | timmy approve | approval |  | Timmy gates paid calls with its own single-use tokens |

### fallbacks

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [model-fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) | **implemented** | timmy commander think --models a,b | commander.turn | commander-core.ts planTurn generate: extra models → body.models fallbacks |  |

### auto-router

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [auto-router](https://openrouter.ai/docs/guides/routing/routers/auto-router) | **implemented** | lane default openrouter/auto | agentrun | src/agent/lanes.ts (openhands LLM_MODEL default) | the commander allowlist pins ids; auto stays a lane default |
| [pareto-code-router](https://openrouter.ai/docs/guides/routing/routers/pareto-router) | **later** | timmy commander think --models openrouter/pareto-code | commander.turn |  | after allowlist suffix/alias support |
| [free-models-router](https://openrouter.ai/docs/guides/routing/routers/free-router) | **implemented** | timmy sim run --free | sim.turn | lanes/sim/sim.mjs --free → actor openrouter/free | a $0 actor tier for rehearsal runs |
| [body-builder](https://openrouter.ai/docs/guides/routing/routers/body-builder) | **implemented** | timmy commander think --mode bodybuilder --native | commander.turn | commander-core.ts native bodybuilder: openrouter/bodybuilder writes the requests, the commander runs the allowlisted ones (parseBodybuilder) |  |
| [fusion-router](https://openrouter.ai/docs/guides/routing/routers/fusion-router) | **implemented** | timmy commander think --mode fusion --native | commander.turn | commander-core.ts native fusion → openrouter/fusion |  |

### caching

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [prompt-caching-cache-control](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | **later** | — | commander.turn |  | commander prompts are short; wire with memory-in-prompt |
| [prompt-caching-automatic](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | **implemented** | timmy commander spend | commander.turn | commander-core.ts usageCost tokens_cached → spend.tokens_cached |  |
| [session-sticky-routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | **implemented** | (every commander call) | commander.turn | commander-core.ts chatOptionsFor session_id = commander:<room> (timmy:<room> on a Timmy) |  |
| [response-caching](https://openrouter.ai/docs/guides/features/response-caching) *(unverified)* | **later** | — | — |  | unverified |

### multimodal

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [pdf-input-file-parser](https://openrouter.ai/docs/guides/overview/multimodal/pdfs) | **later** | timmy commander think --file | commander.turn |  | after multimodal in the commander |
| [image-input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding) | **later** | timmy commander think --image | commander.turn |  | the observer lane uses Roboflow for images today |
| [audio-input-output](https://openrouter.ai/docs/guides/overview/multimodal/audio) | **later** | — | — |  |  |
| [video-input](https://openrouter.ai/docs/guides/overview/multimodal/videos) | **later** | — | — |  |  |
| [image-generation-api](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) | **implemented** | timmy gen | gen.run | src/utils/providers.ts (image models through OpenRouter) + GENS ledger | the dedicated /images endpoint is later; today images ride the chat route |
| [video-generation-api](https://openrouter.ai/docs/guides/overview/multimodal/video-generation) | **implemented** | timmy gen | gen.run | src/utils/providers.ts (happyhorse-1.1) | the dedicated /videos job endpoint is later |
| [text-to-speech](https://openrouter.ai/docs/guides/overview/multimodal/tts) | **later** | timmy gen --kind tts | gen.run |  | ElevenLabs lanes exist elsewhere |
| [speech-to-text](https://openrouter.ai/docs/guides/overview/multimodal/stt) | **later** | — | — |  |  |

### transforms

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [context-compression-middle-out](https://openrouter.ai/docs/guides/features/message-transforms) | **later** | timmy commander think | commander.turn |  | commander prompts are short; wire when memory grows into the prompt |

### reasoning

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [reasoning-parameter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) | **implemented** | timmy commander think --reasoning | commander.turn | commander-core.ts chatBody reasoning passthrough; tokens_reasoning in the ledger |  |
| [reasoning-details-preservation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) | **later** | — | — |  | multi-turn reasoning continuity; the commander keeps turns, not threads |

### usage-accounting

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [usage-object](https://openrouter.ai/docs/cookbook/administration/usage-accounting) | **implemented** | timmy commander spend | commander.turn | commander-core.ts usageCost/applySpend (cost, tokens, uncounted) | usage.include is deprecated per the docs (usage always returned): drop the flag |
| [generation-stats](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation) | **implemented** | timmy commander stats --turn\|--id | commander.turn | commander.ts read stats → commander-core.ts generationStats (GET /generation?id); generation_id stored on every call | exact native cost per generation |
| [zero-completion-insurance](https://openrouter.ai/docs/guides/features/zero-completion-insurance) | **implemented** | (billing) | — | automatic | nothing to wire |
| [generation-feedback-and-stored-content](https://openrouter.ai/docs/api/api-reference/generations/submit-feedback-for-a-generation) *(unverified)* | **later** | — | — |  | unverified |

### embeddings

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [embeddings-api](https://openrouter.ai/docs/api_reference/embeddings) | **later** | — | — |  | CPO embeddings are local/Zilliz (Sparks plan) |
| [rerank-api](https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request) | **later** | — | — |  | same |

### keys-auth

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [bearer-api-key-auth](https://openrouter.ai/docs/api_reference/authentication) | **implemented** | (every call) | — | worker secret OPENROUTER_API_KEY; lanes read process.env |  |
| [oauth-pkce](https://openrouter.ai/docs/guides/overview/auth/oauth) | **later** | timmy connect openrouter | connect |  | single-operator setup; env key suffices |
| [workload-identity-federation](https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation) *(unverified)* | **later** | — | — |  | unverified |
| [management-api-keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) | **implemented** | timmy project new --budget | project.new | lanes/project/project.mjs mintProjectKey: POST /api/v1/keys limit = budget when OPENROUTER_PROVISIONING_KEY is set; recorded as not provisioned otherwise | the cap enforced by OpenRouter when a provisioning key exists |
| [byok](https://openrouter.ai/docs/guides/overview/auth/byok) | **later** | — | — |  |  |

### rate-limits

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [current-key-limits](https://openrouter.ai/docs/api_reference/limits) | **implemented** | timmy cf pane | cf.pane | lanes/cf/pane.mjs spend.openrouter.key (/auth/key) |  |
| [rate-limits](https://openrouter.ai/docs/api_reference/limits) | **implemented** | /chat | — | workers/ai-proxy/src/index.ts (429 passthrough + own RATE_LIMIT_PER_MIN) |  |

### credits-analytics

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) | **implemented** | timmy cf pane | cf.pane | lanes/cf/pane.mjs spend.openrouter.credits |  |
| [analytics](https://openrouter.ai/docs/api/api-reference/analytics/query-analytics-data) | **implemented** | timmy cf pane | cf.pane | lanes/cf/pane.mjs openrouter activity source: GET /api/v1/activity (needs OPENROUTER_PROVISIONING_KEY; a dead source shows as dead) |  |

### errors

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [error-shape-and-codes](https://openrouter.ai/docs/api_reference/errors-and-debugging) | **implemented** | (every call) | commander.turn.models[].error | index.ts preserves upstream status/body; commander records upstream errors per call |  |

### sdk-client

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [ts-sdk-package](https://openrouter.ai/docs/client-sdks/typescript/overview) | **implemented** | timmy chat / gen | — | package.json @openrouter/sdk; src/agent/core.ts, src/agent/tools.ts, src/modes/chat/tools.ts |  |
| [ts-sdk-chat-send](https://github.com/OpenRouterTeam/typescript-sdk) | **implemented** | timmy chat | chat.turn | src/agent/core.ts (the agent client) |  |
| [ts-sdk-constructor-attribution](https://openrouter.ai/docs/client-sdks/typescript/sdks/credits/README) | **wire-now** | (sdk) | — | src/agent/core.ts client construction | httpReferer/appTitle/appCategories on the client — src/agent is not on the swarm-b3k7 paths; the worker and every lane already carry attribution (see app-attribution-headers) |
| [sdk-devtools](https://openrouter.ai/docs/agent-sdk/dev-tools/devtools) *(unverified)* | **later** | — | — |  | unverified |

### sdk-agent

| capability | status | verb | receipt | where / how | note |
|---|---|---|---|---|---|
| [agent-sdk-package](https://openrouter.ai/docs/client-sdks/agent-migration) | **later** | — | — |  | @openrouter/agent is not a dependency; the commander is the agent loop |
| [agent-callmodel](https://openrouter.ai/docs/agent-sdk/call-model/api-reference) | **later** | — | — |  | with agent-sdk-package |
| [agent-tool-helper](https://openrouter.ai/docs/agent-sdk/call-model/tools) | **later** | — | — |  | edge tools are zod already (tools.ts) |
| [agent-stop-conditions](https://openrouter.ai/docs/agent-sdk/call-model/stop-conditions) | **later** | — | — |  | the commander has cap + kill |
| [agent-next-turn-params](https://openrouter.ai/docs/agent-sdk/call-model/next-turn-params) | **later** | — | — |  |  |
| [agent-dynamic-parameters](https://openrouter.ai/docs/agent-sdk/call-model/dynamic-parameters) | **later** | — | — |  |  |
| [agent-streaming-methods](https://openrouter.ai/docs/agent-sdk/call-model/streaming) | **later** | — | — |  |  |
| [agent-message-format-converters](https://openrouter.ai/docs/agent-sdk/call-model/message-formats) | **later** | — | — |  |  |
| [agent-mcp-tools](https://openrouter.ai/docs/agent-sdk/call-model/mcp-tools) | **later** | — | — |  | the commander handoff is the MCP surface |
| [agent-lifecycle-hooks](https://openrouter.ai/docs/agent-sdk/call-model/lifecycle-hooks) | **later** | — | — |  | Timmy's pre-tool hook lives in the MCP server |
| [agent-hitl-and-async-tools](https://openrouter.ai/docs/agent-sdk/call-model/tool-approval-state) *(unverified)* | **later** | — | — |  | timmy approve is the HITL gate |

## The two names in the order

- **bodybuilder** is real at OpenRouter: the `openrouter/bodybuilder` router returns `{requests:[…]}` for the caller to run in parallel. Timmy already fans out itself (commander `bodybuilder` mode, `timmy_judge_loop`); wiring the native router is a `--native` flag on the same mode.
- **fusion** is real at OpenRouter: `openrouter/fusion` (a panel of models plus an analyst) and the `openrouter:fusion` server tool. Timmy runs its own actors + judge (commander `fusion` mode, `timmy_fusion_plan`); the native router is the `--native` alternative, and the receipt must say which one answered.
- "judge" exists only as a deprecated alias (`judge_model` → `analyst_model`); "fan-out" is not an OpenRouter term.
