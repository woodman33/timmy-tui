export type ProviderId =
  | 'openrouter'
  | 'openai'
  | 'modal'
  | 'mux'
  | 'fal'
  | 'runcomfy'
  | 'comfydeploy'
  | 'kling'
  | 'higgsfield'
  | 'agora'
  | 'videosdk'
  | 'spark_runner'
  | 'nas_storage';

export type ProviderClassification = 'local' | 'private' | 'external';

export type ProviderService =
  | 'responses'
  | 'chat-completions'
  | 'realtime'
  | 'embeddings'
  | 'image-generation'
  | 'speech'
  | 'transcription'
  | 'moderation'
  | 'video'
  | 'model-catalog'
  | 'private-compute'
  | 'burst-compute'
  | 'artifact-generation'
  | 'video-delivery'
  | 'replay-delivery'
  | 'realtime-media'
  | 'storage'
  | 'workflow-orchestration';

export interface ProviderEnvVar {
  name: string;
  requiredWhenEnabled?: boolean;
  secret?: boolean;
  description: string;
}

export interface ProviderModel {
  id: string;
  label: string;
  use:
    | 'default'
    | 'coding'
    | 'fast'
    | 'low-cost'
    | 'vision'
    | 'audio'
    | 'image'
    | 'embedding'
    | 'moderation';
}

export interface ProviderRegistryEntry {
  id: ProviderId;
  label: string;
  classification: ProviderClassification;
  role: string;
  services: ProviderService[];
  envVars: ProviderEnvVar[];
  defaultModelEnv?: string;
  defaultModel?: string;
  baseUrl?: string;
  docsUrl?: string;
  models?: ProviderModel[];
  notes?: string;
}

export type ProviderReadiness = 'disabled' | 'ready' | 'needs_config';

export interface ProviderAuditEntry {
  id: ProviderId;
  label: string;
  classification: ProviderClassification;
  role: string;
  enabled: boolean;
  readiness: ProviderReadiness;
  presentEnvVars: string[];
  missingRequiredEnvVars: string[];
  checkedEnvVars: string[];
}

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    classification: 'external',
    role: 'Primary model gateway for the existing TIMMY runtime.',
    services: ['chat-completions', 'model-catalog'],
    envVars: [
      {
        name: 'OPENROUTER_API_KEY',
        requiredWhenEnabled: true,
        secret: true,
        description: 'OpenRouter API key for the current runtime client.',
      },
      {
        name: 'OPENROUTER_MODEL',
        description: 'Optional default OpenRouter model override.',
      },
    ],
    defaultModelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'anthropic/claude-opus-4.7',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs',
    models: [
      { id: 'anthropic/claude-opus-4.7', label: 'Configured TIMMY default', use: 'default' },
      { id: 'qwen/qwen-2.5-coder-32b', label: 'Configured tmux coding runner model', use: 'coding' },
      { id: 'nousresearch/hermes-3-llama-3.1-405b', label: 'Configured tmux Hermes runner model', use: 'coding' },
      { id: 'meta/llama-3.3', label: 'Configured tmux systems runner model', use: 'fast' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    classification: 'external',
    role: 'Optional direct OpenAI provider metadata; not used by the current runtime unless explicitly wired later.',
    services: [
      'responses',
      'chat-completions',
      'realtime',
      'embeddings',
      'image-generation',
      'speech',
      'transcription',
      'moderation',
      'video',
      'model-catalog',
    ],
    envVars: [
      {
        name: 'OPENAI_API_KEY',
        requiredWhenEnabled: true,
        secret: true,
        description: 'Optional direct OpenAI API key.',
      },
      {
        name: 'OPENAI_DEFAULT_MODEL',
        description: 'Optional direct OpenAI model configured by the operator.',
      },
    ],
    defaultModelEnv: 'OPENAI_DEFAULT_MODEL',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs',
    notes: 'Specific OpenAI model names are intentionally not hard-coded here; use OPENAI_DEFAULT_MODEL.',
  },
  {
    id: 'modal',
    label: 'Modal',
    classification: 'external',
    role: 'Burst compute plane for heavy jobs that should not run in the TUI process.',
    services: ['burst-compute', 'workflow-orchestration'],
    envVars: [
      { name: 'MODAL_TOKEN_ID', requiredWhenEnabled: true, secret: true, description: 'Modal token id.' },
      { name: 'MODAL_TOKEN_SECRET', requiredWhenEnabled: true, secret: true, description: 'Modal token secret.' },
    ],
    docsUrl: 'https://modal.com/docs',
  },
  {
    id: 'mux',
    label: 'Mux',
    classification: 'external',
    role: 'Replay and video delivery plane for rendered run artifacts.',
    services: ['video-delivery', 'replay-delivery'],
    envVars: [
      { name: 'MUX_TOKEN_ID', requiredWhenEnabled: true, secret: true, description: 'Mux token id.' },
      { name: 'MUX_TOKEN_SECRET', requiredWhenEnabled: true, secret: true, description: 'Mux token secret.' },
    ],
    docsUrl: 'https://docs.mux.com',
  },
  {
    id: 'fal',
    label: 'fal',
    classification: 'external',
    role: 'External media artifact generator for images, video, and model-hosted creative jobs.',
    services: ['artifact-generation', 'image-generation', 'video'],
    envVars: [
      { name: 'FAL_KEY', secret: true, description: 'fal API key (canonical).' },
      { name: 'FALAI_API_KEY', secret: true, description: 'legacy alias accepted by resolveFalCredential.' },
    ],
  },
  {
    id: 'runcomfy',
    label: 'RunComfy',
    classification: 'external',
    role: 'External ComfyUI artifact generation runner.',
    services: ['artifact-generation', 'image-generation', 'video'],
    envVars: [
      { name: 'RUNCOMFY_API_KEY', requiredWhenEnabled: true, secret: true, description: 'RunComfy API key.' },
    ],
  },
  {
    id: 'comfydeploy',
    label: 'ComfyDeploy',
    classification: 'external',
    role: 'External hosted ComfyUI workflow and artifact generator.',
    services: ['artifact-generation', 'workflow-orchestration', 'image-generation', 'video'],
    envVars: [
      {
        name: 'COMFYDEPLOY_API_KEY',
        requiredWhenEnabled: true,
        secret: true,
        description: 'ComfyDeploy API key.',
      },
    ],
  },
  {
    id: 'kling',
    label: 'Kling',
    classification: 'external',
    role: 'External video artifact generator.',
    services: ['artifact-generation', 'video'],
    envVars: [
      { name: 'KLING_API_KEY', requiredWhenEnabled: true, secret: true, description: 'TIMMY convention for Kling API access.' },
    ],
  },
  {
    id: 'higgsfield',
    label: 'Higgsfield',
    classification: 'external',
    role: 'External video and motion artifact generator.',
    services: ['artifact-generation', 'video'],
    envVars: [
      {
        name: 'HIGGSFIELD_API_KEY',
        requiredWhenEnabled: true,
        secret: true,
        description: 'TIMMY convention for Higgsfield API access.',
      },
    ],
  },
  {
    id: 'agora',
    label: 'Agora',
    classification: 'external',
    role: 'Realtime media and session transport provider.',
    services: ['realtime-media'],
    envVars: [
      { name: 'AGORA_APP_ID', requiredWhenEnabled: true, description: 'Agora app id.' },
      { name: 'AGORA_APP_CERTIFICATE', requiredWhenEnabled: true, secret: true, description: 'Agora app certificate.' },
    ],
  },
  {
    id: 'videosdk',
    label: 'VideoSDK',
    classification: 'external',
    role: 'Realtime media and meeting transport provider.',
    services: ['realtime-media'],
    envVars: [
      { name: 'VIDEOSDK_API_KEY', requiredWhenEnabled: true, secret: true, description: 'VideoSDK API key.' },
      { name: 'VIDEOSDK_SECRET_KEY', requiredWhenEnabled: true, secret: true, description: 'VideoSDK secret key.' },
    ],
  },
  {
    id: 'spark_runner',
    label: 'Spark Runner',
    classification: 'private',
    role: 'Private compute plane for sensitive jobs that should stay off external artifact services.',
    services: ['private-compute', 'workflow-orchestration'],
    envVars: [
      { name: 'SPARK_RUNNER_ENABLED', description: 'Enables private Spark runner metadata in local tooling.' },
      { name: 'SPARK_RUNNER_ENDPOINT', requiredWhenEnabled: true, secret: true, description: 'Private Spark runner endpoint or broker URL.' },
      { name: 'SPARK_RUNNER_TOKEN', requiredWhenEnabled: true, secret: true, description: 'Private Spark runner token.' },
    ],
    notes: 'Do not publish private Spark hostnames, paths, tunnels, or machine names.',
  },
  {
    id: 'nas_storage',
    label: 'NAS Storage',
    classification: 'local',
    role: 'Local/private artifact and replay storage backing the Spark compute plane.',
    services: ['storage'],
    envVars: [
      { name: 'NAS_STORAGE_ENABLED', description: 'Enables private NAS metadata in local tooling.' },
      { name: 'NAS_STORAGE_PATH', requiredWhenEnabled: true, secret: true, description: 'Private NAS mount or storage path.' },
    ],
    notes: 'Do not publish NAS hostnames, volume names, credentials, or local mount paths.',
  },
] as const;

function isPresent(value: string | undefined): boolean {
  if (!value) return false;
  return !/^(false|no|0|your-|paste_|changeme|change_me|example|placeholder)$/i.test(value.trim());
}

export function getProviderRegistry(): readonly ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY;
}

export function getProviderById(id: ProviderId): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find((provider) => provider.id === id);
}

export function auditProvider(
  provider: ProviderRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAuditEntry {
  const checkedEnvVars = provider.envVars.map((entry) => entry.name);
  const presentEnvVars = checkedEnvVars.filter((name) => isPresent(env[name]));
  const enabled = presentEnvVars.length > 0;
  const missingRequiredEnvVars = enabled
    ? provider.envVars
        .filter((entry) => entry.requiredWhenEnabled && !isPresent(env[entry.name]))
        .map((entry) => entry.name)
    : [];

  return {
    id: provider.id,
    label: provider.label,
    classification: provider.classification,
    role: provider.role,
    enabled,
    readiness: !enabled ? 'disabled' : missingRequiredEnvVars.length === 0 ? 'ready' : 'needs_config',
    presentEnvVars,
    missingRequiredEnvVars,
    checkedEnvVars,
  };
}

export function auditProviders(env: NodeJS.ProcessEnv = process.env): ProviderAuditEntry[] {
  return PROVIDER_REGISTRY.map((provider) => auditProvider(provider, env));
}

export function getEnabledProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY.filter((provider) => auditProvider(provider, env).enabled);
}

export function getDefaultModelForProvider(
  id: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const provider = getProviderById(id);
  if (!provider) return undefined;
  return (provider.defaultModelEnv ? env[provider.defaultModelEnv] : undefined) || provider.defaultModel;
}
