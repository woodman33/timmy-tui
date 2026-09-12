# OpenRouter capability inventory — sources

Generated 2026-09-07T10:34:19Z. Every page was read live with WebFetch (a small model summarized each page against a targeted prompt); fetch times are per-batch approximations (each batch of parallel fetches shares one timestamp). Companion file: `capabilities.inventory.json`.

## Fetched URLs (HTTP status, fetch time UTC)

### Batch 1 — 2026-09-07T10:14Z (legacy paths, first pass)
- https://openrouter.ai/docs/quickstart — 200
- https://openrouter.ai/docs/api-reference/overview — 200 (legacy path; served the current API overview)
- https://openrouter.ai/docs/features/provider-routing — 200 (legacy path; served provider-selection content)
- https://openrouter.ai/docs/features/model-routing — 200 (legacy path; served the Auto Router page)
- https://openrouter.ai/docs/features/tool-calling — **404**
- https://openrouter.ai/docs/features/structured-outputs — 200
- https://openrouter.ai/docs/features/prompt-caching — 200
- https://openrouter.ai/docs/features/web-search — 200
- https://openrouter.ai/docs/features/reasoning-tokens — **404**
- https://openrouter.ai/docs/features/message-transforms — 200
- https://openrouter.ai/docs/use-cases/usage-accounting — 200
- https://openrouter.ai/docs/api-reference/streaming — 200
- https://openrouter.ai/docs/api-reference/limits — 200
- https://openrouter.ai/docs/api-reference/errors — 200
- https://openrouter.ai/docs/use-cases/oauth-pkce — 200
- https://openrouter.ai/docs/sdks/typescript — 200
- https://github.com/OpenRouterTeam/typescript-sdk — 200
- https://www.npmjs.com/package/@openrouter/sdk — **403** (used registry.npmjs.org instead)

### Batch 2 — 2026-09-07T10:18Z (index + canonical paths)
- https://openrouter.ai/docs/llms.txt — 200 (full docs index, 558 lines; drove the rest of the crawl)
- https://openrouter.ai/docs/api_reference/responses/overview — 200
- https://openrouter.ai/docs/api_reference/embeddings — 200
- https://openrouter.ai/docs/api_reference/parameters — 200
- https://openrouter.ai/docs/guides/routing/model-fallbacks — 200
- https://openrouter.ai/docs/guides/features/plugins — 200
- https://openrouter.ai/docs/guides/features/zdr — 200
- https://openrouter.ai/docs/guides/privacy/provider-logging — 200
- https://openrouter.ai/docs/guides/overview/mcp-server — 200
- https://openrouter.ai/docs/agent-sdk/overview — 200
- https://openrouter.ai/docs/sdks/call-model/overview — 200
- https://openrouter.ai/docs/sdks/call-model/stop-conditions — 200
- https://openrouter.ai/docs/sdks/call-model/api-reference — 200
- https://openrouter.ai/docs/client-sdks/overview — 200
- https://openrouter.ai/docs/guides/features/service-tiers — 200
- https://openrouter.ai/docs/guides/features/guardrails — 200
- https://openrouter.ai/docs/guides/routing/routers/latest-resolution — 200
- https://openrouter.ai/docs/guides/features/plugins/response-healing — 200
- https://openrouter.ai/docs/app-attribution — 200
- https://registry.npmjs.org/@openrouter/sdk/latest — 200 (version 1.2.107)
- https://registry.npmjs.org/@openrouter/agent/latest — 200 (version 0.11.0)

### Batch 3 — 2026-09-07T10:22Z (routers, multimodal, endpoint refs)
- https://openrouter.ai/docs/guides/routing/routers/body-builder — 200
- https://openrouter.ai/docs/guides/routing/routers/fusion-router — 200
- https://openrouter.ai/docs/guides/routing/routers/auto-router — 200
- https://openrouter.ai/docs/guides/routing/routers/pareto-router — 200
- https://openrouter.ai/docs/guides/routing/routers/free-router — 200
- https://openrouter.ai/docs/guides/features/tool-calling — 200
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens — 200
- https://openrouter.ai/docs/guides/overview/multimodal/overview — 200
- https://openrouter.ai/docs/guides/overview/multimodal/pdfs — 200
- https://openrouter.ai/docs/guides/overview/multimodal/image-understanding — 200
- https://openrouter.ai/docs/guides/overview/multimodal/audio — 200
- https://openrouter.ai/docs/guides/overview/multimodal/videos — 200
- https://openrouter.ai/docs/guides/overview/multimodal/image-generation — 200
- https://openrouter.ai/docs/guides/overview/multimodal/video-generation — 200
- https://openrouter.ai/docs/guides/overview/multimodal/tts — 200
- https://openrouter.ai/docs/guides/overview/multimodal/stt — 200
- https://openrouter.ai/docs/guides/features/server-tools/web-search — 200
- https://openrouter.ai/docs/guides/features/server-tools/advisor — 200
- https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties — 200
- https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation — 200
- https://openrouter.ai/docs/api/api-reference/providers/list-providers — 200
- https://openrouter.ai/docs/api/api-reference/presets/create-presets-chat-completions — **404** (guessed slug; correct page fetched in batch 5)
- https://openrouter.ai/docs/batch-quickstart — 200

### Batch 4 — 2026-09-07T10:25Z
- https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request — 200
- https://openrouter.ai/docs/api/api-reference/responses/create-responses — **404** (index slug is `responses/create-a-response`; not re-fetched)
- https://openrouter.ai/docs/api_reference/responses/tool-calling — 200
- https://openrouter.ai/docs/api_reference/responses/reasoning — 200
- https://openrouter.ai/docs/guides/features/router-metadata — 200
- https://openrouter.ai/docs/guides/routing/model-variants/free — 200

### Batch 5 — 2026-09-07T10:28Z (term checks, auth, keys, SDK sub-pages)
- https://openrouter.ai/docs/guides/features/server-tools/fusion — 200
- https://openrouter.ai/docs/guides/features/plugins/fusion — 200 (fetched twice; second pass was a literal string search for fan-out / judge)
- https://openrouter.ai/docs/changelog — 200
- https://openrouter.ai/docs/guides/ori/eval — 200
- https://openrouter.ai/docs/guides/routing/model-variants/exacto — 200
- https://openrouter.ai/docs/guides/routing/auto-exacto — 200
- https://openrouter.ai/docs/guides/features/server-tools — 200
- https://openrouter.ai/docs/guides/overview/auth/oauth — 200
- https://openrouter.ai/docs/guides/overview/auth/management-api-keys — 200
- https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key — 200
- https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits — 200
- https://openrouter.ai/docs/api/api-reference/analytics/query-analytics-data — 200
- https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model — 200
- https://openrouter.ai/docs/api/api-reference/presets/create-a-preset-from-a-chat-completions-request-body — 200
- https://openrouter.ai/docs/guides/features/broadcast — 200
- https://openrouter.ai/docs/api_reference/authentication — 200
- https://openrouter.ai/docs/api_reference/versioning — 200
- https://openrouter.ai/docs/guides/features/in-region-routing — 200
- https://openrouter.ai/docs/guides/overview/auth/byok — 200
- https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message — 200
- https://openrouter.ai/docs/agent-sdk/call-model/tools — 200
- https://openrouter.ai/docs/agent-sdk/call-model/next-turn-params — 200
- https://openrouter.ai/docs/agent-sdk/call-model/dynamic-parameters — 200
- https://openrouter.ai/docs/agent-sdk/call-model/streaming — 200
- https://openrouter.ai/docs/agent-sdk/call-model/message-formats — 200
- https://openrouter.ai/docs/agent-sdk/call-model/mcp-tools — 200
- https://openrouter.ai/docs/agent-sdk/call-model/lifecycle-hooks — 200
- https://openrouter.ai/docs/client-sdks/typescript/overview — 200
- https://openrouter.ai/docs/client-sdks/typescript/sdks/oauth/README — 200
- https://openrouter.ai/docs/client-sdks/typescript/sdks/apikeys/README — 200
- https://openrouter.ai/docs/client-sdks/typescript/sdks/credits/README — 200
- https://openrouter.ai/docs/client-sdks/typescript/sdks/analytics/README — 200
- https://openrouter.ai/docs/client-sdks/agent-migration — 200
- https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request — 200

### Batch 6 — 2026-09-07T10:32Z
- https://openrouter.ai/docs/guides/features/presets — 200
- https://openrouter.ai/docs/guides/features/zero-completion-insurance — 200
- https://openrouter.ai/docs/guides/routing/model-variants/thinking — 200
- https://openrouter.ai/docs/guides/routing/model-variants/extended — 200
- https://openrouter.ai/docs/guides/features/input-output-logging — 200
- https://github.com/OpenRouterTeam/typescript-agent — 200
- https://openrouter.ai/docs/guides/features/server-tools/subagent — 200
- https://openrouter.ai/docs/guides/features/server-tools/web-fetch — 200
- https://openrouter.ai/docs/api_reference/responses/basic-usage — 200

### WebSearch queries used to locate pages
- `site:openrouter.ai/docs responses API`
- `site:openrouter.ai/docs embeddings`
- `openrouter docs typescript sdk callModel stopWhen stepCountIs maxCost hasToolCall nextTurnParams`
- `site:openrouter.ai/docs "body builder" OR bodybuilder router`
- `site:openrouter.ai/docs tool calling parallel tool_choice`
- `site:openrouter.ai/docs reasoning tokens effort exclude`
- `site:openrouter.ai/docs exacto variant`
- `site:openrouter.ai/docs "judge" OR "fan-out" OR "fanout"`
- `site:openrouter.ai/docs "/api/v1/completions" text completion prompt endpoint`

### Pages listed in the index but NOT fetched (marked `unverified` where used)
`responses/create-a-response` endpoint ref, `models/list-models-filtered-by-user-...`, `response-caching`, `workload-identity-federation`, `workspaces`, `files/*`, `containers/*`, `guardrails/*` endpoint refs, `benchmarks`, `datasets/*`, `classifications`, `generations/submit-feedback` and `get-stored-prompt-...`, `agent-sdk/call-model/{async-tools,doom-loop-detection,tool-approval-state,items,text-generation}`, `dev-tools/devtools`, server-tool pages for `datetime`, `image-generation`, `apply-patch`, `shell`, `bash`, `search-models`, `tool-search`, the `:nitro`/`:floor`/`:online` variant pages, `latency-and-performance`, `uptime-optimization`, `private-models`, `sovereign-ai`, `classifiers`, `data-collection`, `stripe-projects`, `terraform`, Python/Go SDK pages, cookbook pages.

## What changed vs. common knowledge

Things in the current docs that differ from what an older model (or pre-2026 memory of OpenRouter) would assume:

1. **Docs tree reorganized.** Canonical paths are now `/docs/api_reference/*`, `/docs/api/api-reference/*` (endpoint refs), `/docs/guides/{features,routing,overview,best-practices,privacy,ori,community}/*`, `/docs/client-sdks/*`, `/docs/agent-sdk/*`. `/docs/features/tool-calling` and `/docs/features/reasoning-tokens` now 404; other legacy paths silently serve the new pages. The complete index is `https://openrouter.ai/docs/llms.txt`.
2. **`callModel` moved out of `@openrouter/sdk`** into a separate **`@openrouter/agent`** package (npm 0.11.0; depends on `zod ^4` and `@openrouter/sdk`; optional peer `@modelcontextprotocol/client`). `@openrouter/sdk` (1.2.107, ESM-only) is now the auto-generated OpenAPI client; the agent exports there are scheduled for removal in a future major.
3. **Stop-condition helpers are `stepCountIs`, `hasToolCall`, `maxTokensUsed`, `maxCost`, `finishReasonIs`.** Default when `stopWhen` is omitted: loop until a turn has no tool calls (an older search snippet said `stepCountIs(5)`; the current page does not). `maxToolRounds` is deprecated; `allowFinalResponse` is new.
4. **Format converters are `fromChatMessages` / `toChatMessage` / `fromClaudeMessages` / `toClaudeMessage`.** No `toResponsesAPI`, `toCompletionsAPI`, `toAISDK` or `toDeltas` helpers are documented.
5. **`usage.include` and `stream_options.include_usage` are deprecated and no-ops** — usage (with `cost`, `cost_details`, cache and reasoning token details) is now always returned.
6. **`transforms: ["middle-out"]` is gone as a top-level parameter**; middle-out is the `context-compression` plugin (`plugins: [{id: "context-compression"}]`), on by default only for endpoints with <= 8k context.
7. **The `web` plugin is marked deprecated** in favour of the `openrouter:web_search` **server tool** (model decides when/how often to search). `:online` still works. Engines now include native, exa, firecrawl, parallel and perplexity.
8. **Server tools are a whole new surface**: `openrouter:web_search`, `web_fetch`, `datetime`, `image_generation`, `apply_patch`, `shell`, `bash`, `fusion`, `advisor`, `subagent`, `experimental__search_models`, `tool_search`, declared in the normal `tools` array across Chat, Responses and Messages APIs.
9. **New routers / model slugs**: `openrouter/auto` (now spend-ranked with `cost_tier`/allowed/excluded model filters, plus `openrouter/auto-beta`), `openrouter/free`, `openrouter/pareto-code`, `openrouter/bodybuilder`, `openrouter/fusion` and `openrouter/fusion-flash`, and `~author/family-latest` aliases. `route: "fallback"` is not documented on the fallbacks page any more (the API overview still lists `route`).
10. **`bodybuilder` and `fusion` are real OpenRouter features** (not hallucinations): Body Builder emits parallel request bodies; Fusion runs a panel + analyst. **`judge`** exists only as the deprecated `judge_model` alias of `analyst_model` (changelog 2026-07-28) and Ori Eval's `setupJudge()`. **`fan-out`** was not found on any fetched page.
11. **New provider routing fields**: `zdr`, `enforce_distillable_text`, `preferred_min_throughput` / `preferred_max_latency` (with p50-p99 percentiles), `sort` as an object with `partition`, `max_price`; `quantizations` list grew (mxfp4, nvfp4, fp6, mxfp8). `:exacto` variant and default-on **Auto Exacto** reorder providers by tool-calling quality on any request with tools.
12. **`service_tier`** (`flex` / `priority`, `fast` alias; endpoint ref also lists `auto`, `default`, `scale`) is a first-class parameter; `:nitro`/`:floor` now also admit priority/flex tier endpoints.
13. **Reasoning**: `reasoning.effort` gained `max`, `xhigh`, `minimal`, `none`; `reasoning_effort` shorthand exists; `reasoning_details` blocks are typed (`reasoning.summary` / `reasoning.encrypted` / `reasoning.text` with `signature`) and should be echoed back to preserve interleaved thinking. `:thinking` and `:extended` variants are deprecated.
14. **Prompt caching**: Anthropic caching still needs `cache_control` (now with `ttl: "1h"`); OpenAI, DeepSeek, Gemini 2.5, Grok, Groq, Moonshot, Z.AI are automatic; provider sticky routing keyed by `session_id` / `x-session-id` is new; `cache_write_tokens` is reported.
15. **PDF engines** are `mistral-ocr`, `cloudflare-ai` (free) and `native`; `pdf-text` is deprecated (redirects to cloudflare-ai). The plugins page lists the plugin id as `pdf`, not `file-parser`.
16. **Responses API is GA** (`POST /api/v1/responses`; `beta.responses` / `betaResponses` is a deprecated alias) and strictly stateless (`store: true` / `previous_response_id` -> 400). An **Anthropic Messages API** (`POST /api/v1/messages`) with `fallbacks` (max 3) also exists.
17. **New non-chat endpoints**: embeddings (`/api/v1/embeddings`, multimodal input), rerank (`/api/v1/rerank`), image generation (`/api/v1/images`), async video generation (`/api/v1/videos`), TTS (`/api/v1/audio/speech`), STT (`/api/v1/audio/transcriptions`), batches (`/api/beta/batches`, 50% discount), files, containers, presets, guardrails, observability destinations, workspaces, SCIM, analytics (`/api/v1/analytics/query`), benchmarks, datasets, classifications.
18. **Keys & auth**: management keys live at `/api/v1/keys` (create supports `expires_at`, `limit_reset`, `include_byok_in_limit`, `workspace_id`); `GET /api/v1/key` reports per-key limits and daily/weekly/monthly usage; OAuth PKCE has a **headless mode** (`key_label`, no `callback_url`) and the SDK exposes `oAuth.exchangeAuthCodeForAPIKey` / `createAuthCode`; **workload identity federation** (RFC 8693 + JWKS) is new; the Coinbase crypto charge endpoint is deprecated. BYOK is 5% of list price and has its own `/api/v1/byok` API.
19. **Attribution headers renamed**: `X-OpenRouter-Title` (X-Title kept for compat), plus `X-OpenRouter-Categories` and `X-OpenRouter-App-Visibility`.
20. **Observability**: `X-OpenRouter-Metadata: enabled` returns `openrouter_metadata` (routing strategy incl. `bodybuilder`/`fusion`); Broadcast exports traces to 19 destinations; `trace` / `session_id` / `user` request fields feed it; Input & Output Logging is an opt-in setting.
21. **Privacy/enterprise**: `provider.zdr`, account and guardrail ZDR OR together; `GET /api/v1/endpoints/zdr`; EU/US in-region base URLs (`eu.openrouter.ai`, `us.openrouter.ai`) on Business/Enterprise plans; guardrails return 403.
22. **Rate limits**: free-model limits are 20 RPM / 50 RPD (1,000 RPD after >= $10 purchased); the old "1 request per credit per second" phrasing is gone from the page fetched.
23. **MCP**: OpenRouter hosts its own MCP server (`https://mcp.openrouter.ai/mcp`, 15 tools) and the Agent SDK connects to remote MCP servers via `createMCPTools()`. The Anthropic-style `mcp_servers` request field was not found in the fetched docs.
24. **Zero completion insurance** now explicitly excludes auxiliary fees (web search, PDF OCR, web fetch) from the refund.
