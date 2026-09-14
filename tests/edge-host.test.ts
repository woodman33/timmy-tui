// hosts-j4t1 — the edge host is a config read: overlay → env → inert
// placeholder. The placeholder never silently stands in for a real endpoint,
// and the inert line is exactly one legible sentence.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  edgeHost, edgeUrl, edgeUrlOrNull, inertEdgeUrl, operatorLabel,
  isPlaceholder, EDGE_INERT_LINE, EDGE_HOST_PLACEHOLDER,
} from '../src/utils/edge-host.js';
import { readPrivateJson, writePrivateJson } from '../lanes/privacy/overlay.mjs';

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

  it('respects TIMMY_PRIVATE_DIR for edge and operator config', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'timmy-private-overlay.'));
    const previousPrivateDir = process.env.TIMMY_PRIVATE_DIR;
    const previousEdgeHost = process.env.TIMMY_EDGE_HOST;
    const previousOperatorLabel = process.env.TIMMY_OPERATOR_LABEL;
    try {
      process.env.TIMMY_PRIVATE_DIR = join(scratch, 'private');
      delete process.env.TIMMY_EDGE_HOST;
      delete process.env.TIMMY_OPERATOR_LABEL;
      writePrivateJson('config.json', { edge_host: 'override.example.dev', operator_label: 'override operator' });
      expect(edgeHost()).toBe('override.example.dev');
      expect(operatorLabel()).toBe('override operator');
    } finally {
      if (previousPrivateDir === undefined) delete process.env.TIMMY_PRIVATE_DIR;
      else process.env.TIMMY_PRIVATE_DIR = previousPrivateDir;
      if (previousEdgeHost === undefined) delete process.env.TIMMY_EDGE_HOST;
      else process.env.TIMMY_EDGE_HOST = previousEdgeHost;
      if (previousOperatorLabel === undefined) delete process.env.TIMMY_OPERATOR_LABEL;
      else process.env.TIMMY_OPERATOR_LABEL = previousOperatorLabel;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
