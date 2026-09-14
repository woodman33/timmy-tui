// TIMMY Generation Fabric — provider fleet registry.
// Mirrors the curated table proven live in tools/openrouter-agent (2026-08-04)
// and extends it with the lanes TIMMY routes to. TIMMY never re-implements the
// provider clients: openrouter/venice/wavespeed execute through the user's
// generation agent; local/cloud-api entries are detection + routing metadata.

export type ProviderKind = 'image' | 'video' | 'text' | 'meta';
export type ProviderTransport = 'openrouter' | 'venice' | 'wavespeed' | 'local' | 'cloud-api';

export interface GenerationProvider {
  id: string;
  aliases: string[];
  displayName: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  modelId?: string;
  authEnv?: string[];
  notes?: string;
}

const P = (
  id: string,
  displayName: string,
  kind: ProviderKind,
  transport: ProviderTransport,
  extra: Partial<GenerationProvider> = {}
): GenerationProvider => ({ id, aliases: [id.replace(/-/g, ' ')], displayName, kind, transport, ...extra });

export const GENERATION_PROVIDERS: GenerationProvider[] = [
  // — OpenRouter curated (verified live 2026-08-04 via the generation agent) —
  P('bodybuilder', 'OpenRouter Bodybuilder', 'meta', 'openrouter', { modelId: 'openrouter/bodybuilder', notes: 'builds {"requests":[...]} objects for custom calls' }),
  P('qwen3-8-max', 'Qwen3.8 Max', 'text', 'openrouter', { modelId: 'qwen/qwen3.8-max', aliases: ['qwen3.8-max', 'qwen 3.8 max'], notes: 'default chat / critique brain' }),
  P('nano-banana-2', 'Nano Banana 2', 'image', 'openrouter', { modelId: 'google/gemini-3.1-flash-image', aliases: ['nano banana 2', 'nanobanana 2', 'gemini 3.1 flash image'] }),
  P('nano-banana-pro', 'Nano Banana Pro', 'image', 'openrouter', { modelId: 'google/gemini-3-pro-image', aliases: ['nano banana pro', 'nanobanana pro', 'gemini 3 pro image'] }),
  P('gpt-image-2', 'GPT Image 2', 'image', 'openrouter', { modelId: 'openai/gpt-image-2', aliases: ['gpt image 2'] }),
  P('grok-imagine-image', 'Grok Imagine Image', 'image', 'openrouter', { modelId: 'x-ai/grok-imagine-image-quality', aliases: ['grok imagine 2.0', 'grok imagine image'], notes: '1.5 quality live; 2.0 via catalog' }),
  P('reve-2-1', 'Reve 2.1', 'image', 'openrouter', { aliases: ['reve 2.1', 'reve'], notes: 'resolves through live catalog' }),
  P('ernie-image-turbo', 'ERNIE Image Turbo', 'image', 'local', { aliases: ['ernie image turbo', 'ernie'], notes: 'local Baidu ERNIE lane' }),
  P('happyhorse-1-1', 'HappyHorse 1.1', 'video', 'openrouter', { modelId: 'alibaba/happyhorse-1.1', aliases: ['happy horse 1.1', 'happyhorse 1.1', 'happy horse'] }),
  P('seedance-2-0', 'Seedance 2.0', 'video', 'openrouter', { modelId: 'bytedance/seedance-2.0', aliases: ['seedance 2.0', 'seedance'], notes: 'default video; 4–15s only' }),
  P('seedance-2-5', 'Seedance 2.5', 'video', 'openrouter', { aliases: ['seedance 2.5'], notes: 'resolves through live catalog' }),
  P('wan-2-7', 'Wan 2.7', 'video', 'openrouter', { modelId: 'alibaba/wan-2.7', aliases: ['wan 2.7', 'wan'] }),
  P('kling-3-0', 'Kling 3.0', 'video', 'openrouter', { aliases: ['kling 3.0', 'kling v3', 'kling'], notes: 'live catalog + kling-3-prompting skill' }),
  P('grok-imagine-video', 'Grok Imagine Video 1.5', 'video', 'openrouter', { modelId: 'x-ai/grok-imagine-video-1.5', aliases: ['grok imagine video'] }),
  P('decart', 'Decart', 'video', 'cloud-api', { aliases: ['decart'], notes: 'realtime interactive world model' }),
  // — Venice (uncensored + premiere) —
  P('venice-uncensored', 'Venice Uncensored', 'image', 'venice', { modelId: 'lustify-v8', authEnv: ['VENICE_AI_API_KEY'], aliases: ['venice', 'lustify'], notes: 'safe_mode:false; most_uncensored lane' }),
  P('venice-video', 'Venice Video', 'video', 'venice', { modelId: 'wan-2-7-text-to-video', authEnv: ['VENICE_AI_API_KEY'], aliases: ['venice video'], notes: 'queue → poll → complete' }),
  // — WaveSpeed —
  P('wavespeed', 'WaveSpeed', 'image', 'wavespeed', { modelId: 'wavespeed-ai/flux-dev-lora-ultra-fast', authEnv: ['WAVESPEED_API_KEY'], aliases: ['wavespeed ai', 'wave speed'], notes: 'also t2v paths e.g. wavespeed-ai/wan-2.2/t2v-480p' }),
  // — Local lanes —
  P('comfyui', 'ComfyUI (local)', 'image', 'local', { aliases: ['comfy ui', 'comfyui local'], notes: 'local WebSocket workflow API' }),
  P('open-design', 'Open Design (MCP)', 'image', 'local', { aliases: ['open design', 'opendesign'], notes: 'Open Design daemon MCP · queued gens run via timmy design run <id>' }),
  P('comfyui-controlnet', 'ComfyUI ControlNet', 'image', 'local', { aliases: ['controlnet', 'comfy controlnet'], notes: 'pose/scribble conditioning from the Slate blocking diagram' }),
  // — Cloud API lanes (routed, keyed per user) —
  P('comfydeploy', 'ComfyDeploy', 'image', 'cloud-api', { aliases: ['comfy deploy'], notes: 'hosted ComfyUI workflows' }),
  P('runcomfy', 'RunComfy', 'video', 'cloud-api', { aliases: ['run comfy'], notes: 'kling/seedance/wan endpoints' }),
  P('krea', 'Krea', 'image', 'cloud-api', { modelId: 'krea-v2-large', aliases: ['krea ai', 'krea v2'] }),
  P('modelslab', 'ModelsLab', 'image', 'cloud-api', { aliases: ['models lab'], notes: '50k+ models incl. video fusion' }),
  P('replicate', 'Replicate', 'image', 'cloud-api', { authEnv: ['REPLICATE_API_TOKEN'] }),
  P('fal', 'fal.ai', 'image', 'cloud-api', { authEnv: ['FAL_KEY', 'FALAI_API_KEY'], aliases: ['fal ai', 'fal.ai'], notes: 'FAL_KEY wins over FALAI_API_KEY. Reference-conditioned 3D uses timmy providers fal3d.' }),
  P('huggingface', 'HuggingFace', 'image', 'cloud-api', { authEnv: ['HF_TOKEN'], aliases: ['hf', 'hugging face'] }),
  P('gemini-api', 'Gemini API', 'image', 'cloud-api', { authEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], aliases: ['gemini api'] })
];

export function listProviders(kind?: ProviderKind): GenerationProvider[] {
  return kind ? GENERATION_PROVIDERS.filter(p => p.kind === kind) : GENERATION_PROVIDERS;
}

export function findProvider(query: string): GenerationProvider | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    GENERATION_PROVIDERS.find(p => p.id === q || p.aliases.some(a => a.toLowerCase() === q)) ||
    GENERATION_PROVIDERS.find(p => p.aliases.some(a => a.toLowerCase().includes(q)) || p.id.includes(q.replace(/\s+/g, '-')))
  );
}

// Per-provider generation options — the "more options per provider" layer.
// Options ride the prompt as suffixes the provider CLIs/ APIs understand.
export interface ProviderOption { label: string; suffix: string; }

const AR = (a: string): ProviderOption => ({ label: a, suffix: `--ar ${a}` });
const DUR = (d: string): ProviderOption => ({ label: d, suffix: `--dur ${d}` });
const RES = (r: string): ProviderOption => ({ label: r, suffix: `--res ${r}` });

export const PROVIDER_OPTIONS: Record<string, ProviderOption[]> = {
  'seedance-2-0': [AR('16:9'), AR('9:16'), AR('1:1'), DUR('5s'), DUR('8s'), DUR('12s'), DUR('15s')],
  'seedance-2-5': [AR('16:9'), AR('9:16'), DUR('10s'), DUR('20s'), DUR('30s')],
  'kling-3-0': [AR('16:9'), AR('9:16'), DUR('5s'), DUR('10s')],
  'wan-2-7': [AR('16:9'), AR('9:16'), DUR('5s'), DUR('8s')],
  'happyhorse-1-1': [AR('16:9'), DUR('8s'), DUR('12s')],
  'grok-imagine-video': [DUR('6s'), DUR('10s')],
  'nano-banana-2': [RES('1K'), RES('2K'), RES('4K')],
  'nano-banana-pro': [RES('1K'), RES('2K'), RES('4K')],
  'gpt-image-2': [RES('1024'), RES('1536'), AR('16:9'), AR('9:16')],
  'reve-2-1': [RES('2K'), AR('16:9')],
  'comfyui-controlnet': [{ label: 'scribble', suffix: '--cn scribble' }, { label: 'openpose', suffix: '--cn openpose' }],
  'ernie-image-turbo': [RES('1K'), RES('2K')]
};

export function optionsFor(id: string): ProviderOption[] {
  return PROVIDER_OPTIONS[id] || [];
}

export function providerOverview(kind?: ProviderKind): string {
  const all = listProviders(kind);
  const byTransport = (t: ProviderTransport) => all.filter(p => p.transport === t).map(p => p.id).join(', ');
  return `fleet:${all.length}\n` +
    `openrouter: ${byTransport('openrouter') || '—'}\n` +
    `venice: ${byTransport('venice') || '—'}\n` +
    `wavespeed: ${byTransport('wavespeed') || '—'}\n` +
    `local: ${byTransport('local') || '—'}\n` +
    `cloud-api: ${byTransport('cloud-api') || '—'}`;
}
