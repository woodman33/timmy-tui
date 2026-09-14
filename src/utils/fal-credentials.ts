// Credential resolution only. Never log the returned key or copy it to disk.
export const FAL_CREDENTIAL_NAMES = ['FAL_KEY', 'FALAI_API_KEY'] as const;

export function resolveFalCredential(env: NodeJS.ProcessEnv = process.env):
  { key: string; source: typeof FAL_CREDENTIAL_NAMES[number] } | undefined {
  for (const source of FAL_CREDENTIAL_NAMES) {
    const key = env[source]?.trim();
    if (key && !/^(?:false|no|0|your[-_].*|paste_.*|changeme|change_me|example.*|placeholder.*)$/i.test(key)) {
      return { key, source };
    }
  }
  return undefined;
}
