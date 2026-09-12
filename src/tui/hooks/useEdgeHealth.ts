import { useEffect, useState } from 'react';
import { performance } from 'node:perf_hooks';

export const EDGE_HEALTH_ENDPOINT = 'https://timmy-ai-proxy.wmeldman33.workers.dev/health';
export const EDGE_RUNS_ENDPOINT = 'https://timmy-ai-proxy.wmeldman33.workers.dev/runs';

export interface EdgeHealthStatus {
  state: 'checking' | 'online' | 'offline';
  endpoint: string;
  latencyMs: number | null;
  checkedAt: string | null;
  message: string;
}

const INITIAL_STATUS: EdgeHealthStatus = {
  state: 'checking',
  endpoint: EDGE_HEALTH_ENDPOINT,
  latencyMs: null,
  checkedAt: null,
  message: 'checking edge Durable Object',
};

export function useEdgeHealth(refreshMs = 15000, endpoint = EDGE_HEALTH_ENDPOINT): EdgeHealthStatus {
  const [status, setStatus] = useState<EdgeHealthStatus>({ ...INITIAL_STATUS, endpoint });

  useEffect(() => {
    let mounted = true;
    let interval: NodeJS.Timeout | null = null;

    const check = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const started = performance.now();

      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        const latencyMs = Math.round(performance.now() - started);
        const checkedAt = new Date().toISOString();

        if (!mounted) return;

        if (response.ok) {
          setStatus({
            state: 'online',
            endpoint,
            latencyMs,
            checkedAt,
            message: `connected in ${latencyMs}ms`,
          });
        } else {
          setStatus({
            state: 'offline',
            endpoint,
            latencyMs,
            checkedAt,
            message: `HTTP ${response.status}`,
          });
        }
      } catch (error: any) {
        const latencyMs = Math.round(performance.now() - started);
        if (!mounted) return;
        setStatus({
          state: 'offline',
          endpoint,
          latencyMs,
          checkedAt: new Date().toISOString(),
          message: error?.name === 'AbortError' ? 'timeout' : error?.message || 'unreachable',
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    check();
    interval = setInterval(check, refreshMs);

    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
    };
  }, [endpoint, refreshMs]);

  return status;
}
