// hosts-j4t1 — the edge host is a config read: overlay → env → inert
// placeholder. The placeholder never silently stands in for a real endpoint,
// and the inert line is exactly one legible sentence.
import { describe, it, expect } from 'vitest';
import {
  edgeHost, edgeUrl, edgeUrlOrNull, inertEdgeUrl, operatorLabel,
  isPlaceholder, EDGE_INERT_LINE, EDGE_HOST_PLACEHOLDER,
} from '../src/utils/edge-host.js';
import { readPrivateJson } from '../lanes/privacy/overlay.mjs';

describe('edge-host resolution', () => {
  it('placeholder helpers are exact', () => {
    expect(EDGE_HOST_PLACEHOLDER).toBe('<hostname>');
    expect(EDGE_INERT_LINE).toBe('set TIMMY_EDGE_HOST or the overlay');
    expect(isPlaceholder('<hostname>')).toBe(true);
    expect(isPlaceholder('edge.example.dev')).toBe(false);
    expect(inertEdgeUrl('/runs')).toBe('https://<hostname>/runs');
  });

  it('resolves overlay first, env second, never a placeholder value', () => {
    const overlay = readPrivateJson('config.json');
    const env = process.env.TIMMY_EDGE_HOST;
    const host = edgeHost();
    if (overlay.source === 'private') {
      expect(host).toBe(String((overlay.data as Record<string, unknown>).edge_host));
    } else if (env) {
      expect(host).toBe(env);
    } else {
      expect(host).toBeNull();
      expect(() => edgeUrl('/x')).toThrowError(EDGE_INERT_LINE);
    }
    const u = edgeUrlOrNull('/runs/1/receipt');
    if (u) expect(u).not.toContain('<hostname>');
  });

  it('operator label falls back to a neutral default, never a personal name', () => {
    const label = operatorLabel();
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/william|meldman/i);
  });
});
