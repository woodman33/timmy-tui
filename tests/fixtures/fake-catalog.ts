/**
 * R11 round 7 (H169; the CATALOG METADATA contract, 14:11 PT 2026-10-24): FAKE catalogs that carry a REALISTIC SUBSET of what
 * the providers give, so a page draws real metadata shapes (descriptions, dates, per-token prices, modalities, capabilities,
 * sizes) without a network. Every model here is made up and says so in its name (FAKE); nothing is a real provider's listing.
 *
 *   FAKE_OPENROUTER_CATALOG   what `timmy models --refresh` keeps in the Timmy home as models/openrouter-catalog.json
 *                             (src/models/catalog.ts OpenRouterCatalogModel): write it with writeFakeOpenRouterCatalog(home)
 *   FAKE_OLLAMA_MODELS        what a FAKE Ollama lists (tests/fixtures/fake-ollama-chat.ts startFakeOllama({ models })):
 *                             /api/tags size, details (family, parameter_size, quantization_level) and modified_at;
 *                             /api/show capabilities; one ":cloud" name a cloud-backed model is listed by
 *
 * What a field means is the contract's (an absent field is unknown, never invented): the catalog's `created` is when
 * OpenRouter ADDED a model; `pricing` strings are USD per token; Ollama's `modified_at` is when the weights on this computer
 * were last pulled or changed; a capability the provider does not list stays unknown.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenRouterCatalogModel } from '../../src/models/catalog.js';
import type { FakeModel } from './fake-ollama-chat.js';

/** When the FAKE catalog was "fetched" (a fixed date, so words that name it are stable). */
export const FAKE_CATALOG_FETCHED_AT = '2026-10-22T16:00:00.000Z';

/** Five made-up OpenRouter listings: a paid flagship with vision, a free one, a reasoning model, a router with a variable price, an alias. */
export const FAKE_OPENROUTER_CATALOG: OpenRouterCatalogModel[] = [
  {
    id: 'fake-labs/fake-flagship-4', name: 'Fake Labs: Fake Flagship 4', canonical_slug: 'fake-labs/fake-flagship-4',
    description: 'FAKE listing. A general model for writing, analysis and tool use; reads images. Made up for Timmy\'s tests: no provider lists it.',
    created: 1760745600, context_length: 200000,
    architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'Other' },
    pricing: { prompt: '0.000003', completion: '0.000015', image: '0.0048', request: '0', web_search: '0', internal_reasoning: '0' },
    top_provider: { context_length: 200000, max_completion_tokens: 64000, is_moderated: false },
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'tool_choice', 'response_format'],
  },
  {
    id: 'fake-labs/fake-mini:free', name: 'Fake Labs: Fake Mini (free)', canonical_slug: 'fake-labs/fake-mini',
    description: 'FAKE listing. A small, fast model at no charge; text only. Made up for Timmy\'s tests.',
    created: 1759968000, context_length: 32768,
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 32768, max_completion_tokens: 8192, is_moderated: true },
    supported_parameters: ['max_tokens', 'temperature', 'tools'],
  },
  {
    id: 'other-maker/fake-reasoner-2', name: 'Other Maker: Fake Reasoner 2', canonical_slug: 'other-maker/fake-reasoner-2',
    description: 'FAKE listing. Thinks before it answers (reasoning tokens are billed as output); no tools. Made up for Timmy\'s tests.',
    created: 1758499200, context_length: 131072,
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    pricing: { prompt: '0.0000011', completion: '0.0000044', request: '0', internal_reasoning: '0' },
    top_provider: { context_length: 131072, max_completion_tokens: 32768, is_moderated: false },
    supported_parameters: ['max_tokens', 'temperature', 'reasoning', 'include_reasoning'],
  },
  {
    id: 'fake-router/auto', name: 'Fake Router: Auto', canonical_slug: 'fake-router/auto',
    description: 'FAKE listing. Picks a model per request; its price is the picked model\'s. Made up for Timmy\'s tests.',
    created: 1757376000, context_length: 2000000,
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Router' },
    pricing: { prompt: '-1', completion: '-1', request: '-1', image: '-1' },
    supported_parameters: ['max_tokens', 'temperature'],
  },
  {
    // an alias: no description, no price of its own (unknown stays unknown on the page); it names the model it points at
    id: 'fake-labs/fake-latest', name: 'Fake Labs: Fake Latest', canonical_slug: 'fake-labs/fake-latest',
    created: 1760918400, alias_target: { name: 'Fake Labs: Fake Flagship 4', slug: 'fake-labs/fake-flagship-4' },
  },
];

/** Writes the FAKE OpenRouter catalog where the catalog reader looks (<Timmy home>/models/openrouter-catalog.json). */
export function writeFakeOpenRouterCatalog(home: string, models: OpenRouterCatalogModel[] = FAKE_OPENROUTER_CATALOG): string {
  mkdirSync(join(home, 'models'), { recursive: true });
  const file = join(home, 'models', 'openrouter-catalog.json');
  writeFileSync(file, JSON.stringify({ fetchedAt: FAKE_CATALOG_FETCHED_AT, models }));
  return file;
}

/** Four made-up Ollama models: a tools model, a vision model, an older small one with no capabilities field, a cloud-backed name. */
export const FAKE_OLLAMA_MODELS: FakeModel[] = [
  { name: 'fake-qwen3:8b', capabilities: ['completion', 'tools', 'thinking'], size: 5_225_000_000, modified_at: '2026-10-20T09:12:44.000Z', details: { format: 'gguf', family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
  { name: 'fake-llava:7b', capabilities: ['completion', 'vision'], size: 4_733_000_000, modified_at: '2026-10-18T17:40:03.000Z', details: { format: 'gguf', family: 'llama', parameter_size: '7B', quantization_level: 'Q4_0' } },
  { name: 'fake-tiny:1b', capabilities: null, size: 815_000_000, modified_at: '2026-09-30T08:00:00.000Z', details: { format: 'gguf', family: 'llama', parameter_size: '1.2B', quantization_level: 'Q8_0' } },
  { name: 'fake-big:120b-cloud', capabilities: ['completion', 'tools'], size: 384, remote_host: 'https://ollama.com', modified_at: '2026-10-21T12:00:00.000Z', details: { format: 'gguf', family: 'fake', parameter_size: '120B', quantization_level: 'cloud' } },
];
