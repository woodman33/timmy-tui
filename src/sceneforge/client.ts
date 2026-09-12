import fs from 'node:fs';
import path from 'node:path';
import { callOnce } from 'mcporter';

export type SceneForgeTool =
  | 'sceneforge_capabilities'
  | 'sceneforge_project_status'
  | 'sceneforge_ask'
  | 'sceneforge_note'
  | 'sceneforge_list_jobs'
  | 'sceneforge_propose_job';

export interface SceneForgeCall {
  tool: SceneForgeTool;
  args?: Record<string, unknown>;
}

// privacy-d5n9 follow-up (pii-g8r2): the site-specific default lives in the
// operator's env; the public tree carries only the placeholder form.
const DEFAULT_URL = process.env.SCENEFORGE_MCP_URL ?? 'https://houdini-mcp-agent.<hostname>/mcp';

function configContents(): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        'sceneforge-cloud': {
          description:
            'SceneForge memory, coordination, and inert job proposal control plane.',
          baseUrl: '${SCENEFORGE_MCP_URL:-' + DEFAULT_URL + '}',
          headers: {
            Authorization: 'Bearer ${SCENEFORGE_AGENT_KEY}',
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function ensureSceneForgeConfig(
  workspaceRoot = process.env.TIMMY_WORKSPACE_ROOT || process.cwd(),
): string {
  const configuredPath = process.env.SCENEFORGE_MCPORTER_CONFIG;
  if (configuredPath) return path.resolve(configuredPath);

  const targetDir = path.join(workspaceRoot, '.timmy', 'sceneforge');
  const targetPath = path.join(targetDir, 'mcporter.json');
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, configContents(), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  return targetPath;
}

export function assertSceneForgeConfigured(): void {
  if (!process.env.SCENEFORGE_AGENT_KEY) {
    throw new Error(
      'SCENEFORGE_AGENT_KEY is required. Keep it in your shell/keychain; TIMMY never writes it to receipts.',
    );
  }
}

export async function callSceneForge(
  call: SceneForgeCall,
  workspaceRoot?: string,
): Promise<unknown> {
  assertSceneForgeConfigured();
  const configPath = ensureSceneForgeConfig(workspaceRoot);
  return callOnce({
    server: 'sceneforge-cloud',
    toolName: call.tool,
    args: call.args,
    configPath,
    disableOAuth: true,
  });
}

export function sceneForgeUrl(): string {
  return process.env.SCENEFORGE_MCP_URL || DEFAULT_URL;
}
