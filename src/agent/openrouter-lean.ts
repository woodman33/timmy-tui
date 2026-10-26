/**
 * R12 (the operator's order of 2026-10-25, 21:15 PT: "update it now", @openrouter/sdk 0.12.35 → 1.5.7): the SDK's own
 * `callModel` on the SDK's own core client, without its main entry.
 *
 * Why: 1.5.7's main entry (`import { OpenRouter } from '@openrouter/sdk'`) loads every namespace it ships (1232 files against
 * 0.12.35's 518). Measured on the lead's container, importing it took about 3.5 s against about 1.0 s for `core.js` and
 * `funcs/call-model.js`; a process that only makes an agent went from about 4.4 s to about 7 s, and two start-up tests ran
 * out of time. `OpenRouter#callModel` is exactly `callModel(this, request, options)` (sdk/sdk.js), and `OpenRouter` is an
 * `OpenRouterCore` with its namespaces added, so this class calls the same function on the same client: the same tool loop,
 * streams, stop conditions, cancel and usage, from the same package.
 *
 * `server: 'production'` unless a test names its local `serverURL`: always OpenRouter's own address, as 0.12.35 did. The SDK
 * 1.x otherwise takes OPENROUTER_BASE_URL from the environment, which would send the key and every turn somewhere the route
 * policy never sees.
 */
import type { OpenRouter } from '@openrouter/sdk';
import { OpenRouterCore } from '@openrouter/sdk/core.js';
import { callModel } from '@openrouter/sdk/funcs/call-model.js';

export interface LeanClientOptions { apiKey: string; serverURL?: string }

/** The SDK's core client with its `callModel` (typed as `OpenRouter['callModel']`; the type import costs nothing at run time). */
export class OpenRouterClient {
  readonly core: OpenRouterCore;
  readonly callModel: OpenRouter['callModel'];
  constructor(o: LeanClientOptions) {
    const core = new OpenRouterCore({ apiKey: o.apiKey, ...(o.serverURL ? { serverURL: o.serverURL } : { server: 'production' as const }) });
    this.core = core;
    this.callModel = ((request: Parameters<OpenRouter['callModel']>[0], options?: Parameters<OpenRouter['callModel']>[1]) => callModel(core, request, options)) as OpenRouter['callModel'];
  }
}
