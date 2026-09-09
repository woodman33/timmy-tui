# Provider Registry

The provider registry is additive metadata. It does not change the current TIMMY runtime path, which remains OpenRouter-first through `@openrouter/sdk`.

## Source

Provider metadata lives in `src/agent/provider-registry.ts`.

The registry includes:

- provider id and label
- local, private, or external classification
- provider role in the TIMMY system
- environment variable names
- service families
- optional documentation URL
- optional existing-runtime model metadata

## Runtime Boundary

The registry does not import provider SDKs, call provider APIs, or require provider credentials on startup. A provider is considered enabled only when one of its configured environment variables is present in the real environment or local `.env`.

`timmy providers audit` reports readiness by variable name only. It never prints secret values.

For fal, `FALAI_API_KEY` is an accepted fallback alias for `FAL_KEY`. Registry
readiness establishes configuration presence only. The additive
[`timmy providers fal3d`](fal3d-provider.md) route offers a read-only live
credential check, offline reference-bound plans, operator-gated queue
submission and resumable GLB collection.

## OpenRouter

OpenRouter remains the active default provider. TIMMY reads:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`

The model explorer still fetches the live OpenRouter catalog from `https://openrouter.ai/api/v1/models` through `src/agent/openrouter-client.ts`.

OpenRouter model entries in the registry are limited to models already referenced by existing project runtime configuration.

## OpenAI API

The OpenAI provider entry is optional and direct. It reads:

- `OPENAI_API_KEY`
- `OPENAI_DEFAULT_MODEL`

The registry records service families only. It intentionally does not claim specific OpenAI model names. The direct OpenAI model should be configured by `OPENAI_DEFAULT_MODEL` when a future runtime path enables that provider.

## Compute and Media Providers

- Cloudflare is the control plane for TIMMY orchestration, Durable Object state, queueing, and edge deployment.
- Sparks are the private compute plane for sensitive work that should stay off external artifact generators.
- Modal is metadata for burst compute when a job needs short-lived external capacity.
- Mux is metadata for replay and video delivery.
- fal, RunComfy, ComfyDeploy, Kling, and Higgsfield are external artifact generation providers.
- Agora and VideoSDK are external realtime media transport providers.
- NAS storage is local/private artifact storage for Spark outputs and replay source files.

## Runtime Rule

Do not remove OpenRouter behavior when adding direct provider support. A future runtime switch should choose a provider explicitly and keep OpenRouter fallback intact.
