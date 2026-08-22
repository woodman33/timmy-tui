import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Agent } from '../../agent/core.js';
import { PanelFrame } from '../components/PanelFrame.js';
import { statusGlyph } from '../components/StatusGlyph.js';
import {
  listGenerations, updateGeneration, recordGeneration,
  deriveStatusFromLog, extractArtifactFromLog, parseCostFromLog,
  generationsOverview, type GenerationRecord
} from '../../utils/generations.js';
import { GENERATION_PROVIDERS, optionsFor } from '../../utils/providers.js';
import { locateGenAgent, buildGenAgentArgs, launchDetached } from '../../utils/genbridge.js';
import { clockTime } from '../../utils/humanlog.js';
import { appendGenEvent } from '../../utils/generations.js';
import { seedStarter } from '../../utils/starter.js';
import { osc52Copy } from '../../utils/notify.js';
import { theme } from '../theme.js';

interface GensPanelProps {
  agent: Agent;
  setInspector?: (s: string | null) => void;
  zone?: number;
  setZone?: (z: number) => void;
  setModalInput?: (b: boolean) => void;
  inputLocked?: boolean;
}

/**
 * GENS — the generation fabric as a control room. Queue prompts at any
 * provider, watch statuses flip live, inspect prompts/costs/artifacts.
 * Every run is ledgered and sealed; nothing here is simulated.
 */
export function GensPanel({ agent, zone = 0, setZone, setModalInput, inputLocked }: GensPanelProps) {
  const [gens, setGens] = useState<GenerationRecord[]>([]);
  const [idx, setIdx] = useState(0);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [provIdx, setProvIdx] = useState(0);
  const [optIdx, setOptIdx] = useState(0);
  const [note, setNote] = useState('');

  const providers = GENERATION_PROVIDERS.filter(p => p.kind === 'image' || p.kind === 'video');
  const prov = providers[provIdx % providers.length];

  useEffect(() => {
    const load = () => {
      seedStarter();
      for (const g of listGenerations({}).slice(0, 40)) {
        if (g.log && existsSync(g.log)) {
          const t = readFileSync(g.log, 'utf8');
          const st = deriveStatusFromLog(t, g.status);
          const art = g.artifact || extractArtifactFromLog(t);
          const cost = g.cost_usd ?? parseCostFromLog(t);
          if (st !== g.status || art !== g.artifact || cost !== g.cost_usd) {
            updateGeneration(g.id, { status: st, artifact: art, cost_usd: cost });
          }
        }
      }
      // status flips become live rain events (✓ done / ✕ failed / ● running)
      setGens(prev => {
        const next = listGenerations({}).slice(0, 40);
        for (const g of next) {
          const old = prev.find(p => p.id === g.id);
          if (old && old.status !== g.status) appendGenEvent(g.id, 'status', g.status);
        }
        return next;
      });
    };
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  const sel = gens[Math.min(idx, Math.max(0, gens.length - 1))];

  useInput((char, key) => {
    if (zone < 0) return; // nav owns the keyboard
    if (composing) {
      if (key.escape) { setComposing(false); setDraft(''); setModalInput?.(false); return; }
      // chat-style picker: arrows move the provider list, not the ledger
      if (key.upArrow) { setProvIdx(i => Math.max(0, i - 1)); setOptIdx(0); return; }
      if (key.downArrow) { setProvIdx(i => Math.min(providers.length - 1, i + 1)); setOptIdx(0); return; }
      if (char === ']') { setOptIdx(o => o + 1); return; }
      if (char === '[') { setOptIdx(o => Math.max(0, o - 1)); return; }
      if (key.return) {
        const prompt = draft.trim();
        if (prompt && prov) {
          const opts = optionsFor(prov.id);
          const opt = opts.length ? opts[optIdx % opts.length] : undefined;
          const fullPrompt = opt ? `${prompt} ${opt.suffix}` : prompt;
          const genDir = locateGenAgent();
          const sargs = buildGenAgentArgs(prov, fullPrompt);
          const launched = Boolean(genDir && sargs);
          const rec = recordGeneration({
            prompt: fullPrompt, provider: prov.id, model: prov.modelId, kind: prov.kind,
            transport: prov.transport, status: launched ? 'running' : 'queued'
          });
          if (launched) {
            const log = join(process.cwd(), '.timmy', 'runs', `${rec.id}.log`);
            updateGeneration(rec.id, { log });
            launchDetached(genDir as string, sargs as string[], log);
          }
          agent.emit('run.created' as any, { runId: rec.id, source: 'timmy-gens', provider: prov.id, prompt_hash: rec.prompt_hash, timestamp: Date.now() });
          if (prov.id === 'open-design') setNote(`queued — run: timmy design run ${rec.id}`);
        }
        setComposing(false);
        setDraft('');
        setModalInput?.(false);
        return;
      }
      if (key.backspace || key.delete) { setDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setDraft(d => d + char);
      return;
    }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(Math.max(0, gens.length - 1), i + 1)); return; }
    // ONE GRAMMAR: ←→ move between panes (nav ↔ ledger ↔ detail)
    if (key.leftArrow) { setZone?.(Math.max(-1, zone - 1)); return; }
    if (key.rightArrow) { setZone?.(Math.min(1, zone + 1)); return; }
    // actionable errors: a failure is a decision, not a wall
    if (sel?.status === 'failed') {
      if (char.toLowerCase() === '1') {
        const fallbackId = sel.kind === 'video' ? 'comfyui' : 'ernie-image-turbo';
        const prov = GENERATION_PROVIDERS.find(p => p.id === fallbackId);
        if (prov) {
          const genDir = locateGenAgent();
          const sargs = buildGenAgentArgs(prov, sel.prompt);
          const launched = Boolean(genDir && sargs);
          const rec = recordGeneration({
            prompt: sel.prompt, provider: prov.id, model: prov.modelId, kind: prov.kind,
            transport: prov.transport, status: launched ? 'running' : 'queued', recursion_of: sel.id
          });
          if (launched) {
            const log = join(process.cwd(), '.timmy', 'runs', `${rec.id}.log`);
            updateGeneration(rec.id, { log });
            launchDetached(genDir as string, sargs as string[], log);
          }
          setNote(`rerouted to ${prov.id} (local — no credits needed) · ${rec.id}`);
        }
        return;
      }
      if (char.toLowerCase() === '2') {
        try {
          mkdirSync(join(process.cwd(), '.timmy'), { recursive: true });
          appendFileSync(join(process.cwd(), '.timmy', 'notes.md'), `- ${new Date().toISOString()} · top up OpenRouter credits (gen ${sel.id} failed: 402)\n`, 'utf8');
          setNote('note logged to .timmy/notes.md');
        } catch { setNote('could not write note'); }
        return;
      }
    }
    if (char.toLowerCase() === 'y' && sel) {
      osc52Copy(`${sel.id} · ${sel.provider} · ${sel.status} · ${sel.artifact || 'no artifact'} · prompt_hash=${sel.prompt_hash ?? '—'}`);
      setNote('yanked gen line to clipboard (OSC-52/pbcopy)');
      return;
    }
    if (char.toLowerCase() === 'n') { setComposing(true); setModalInput?.(true); return; }
  }, { isActive: !inputLocked });

  return (
    <PanelFrame
      icon="🎬"
      title="GENERATION CONTROL ROOM"
      status={generationsOverview()}
      statusColor={theme.brand}
      explain="Queue prompts at any provider; watch statuses flip live; every run ledgered, costed, sealed."
      hints={[
        { key: '↑↓', label: 'select' },
        { key: 'n', label: 'new prompt' },
        { key: ']/[', label: 'option (while typing)' },
        { key: '1/2', label: 'failed → reroute / note' }
      ]}
    >
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width="46%" paddingRight={1} borderStyle="single" borderColor={zone === 0 ? theme.brand : theme.borderDefault}>
          {gens.length === 0 && (
            <Box flexDirection="column">
              <Text color={theme.textSecondary}>no generations yet.</Text>
              <Text color={theme.textSecondary}>[n] writes a prompt — ↑↓ picks a provider, ] cycles its options.</Text>
            </Box>
          )}
          {gens.map((g, i) => {
            const glyph = statusGlyph(g.status === 'done' ? 'sealed' : g.status === 'failed' ? 'failed' : g.status === 'running' ? 'running' : 'queued');
            const isSel = i === Math.min(idx, gens.length - 1);
            return (
              <Text key={g.id} color={isSel ? theme.brand : glyph.color} bold={isSel} wrap="truncate">
                {isSel ? '▶ ' : '  '}{glyph.glyph} {clockTime(g.created_at).slice(0, 5)} {g.provider.padEnd(16)}{g.cost_usd !== undefined ? ` $${g.cost_usd.toFixed(3)}` : ''} {g.prompt.slice(0, 22)}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {sel ? (
            <>
              <Text bold color={theme.brand} wrap="truncate">{sel.provider}{sel.model ? ` · ${sel.model}` : ''} · {sel.status}</Text>
              <Text color={theme.textSecondary}>{sel.created_at.replace('T', ' ').slice(0, 19)} · {sel.transport}{sel.cost_usd !== undefined ? ` · $${sel.cost_usd.toFixed(4)}` : ''}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text wrap="wrap">{sel.prompt}</Text>
              </Box>
              {sel.artifact && <Text color={theme.success}>→ {sel.artifact}</Text>}
              {sel.framesDir && <Text color={theme.textSecondary}>frames: {sel.framesDir} ({sel.frameCount || 0})</Text>}
              {sel.log && existsSync(sel.log) && (
                <Box flexDirection="column" marginTop={1}>
                  {readFileSync(sel.log, 'utf8').split('\n').filter(Boolean).slice(-4).map((l, i) => (
                    <Text key={i} color={theme.textSecondary} wrap="truncate">{l}</Text>
                  ))}
                </Box>
              )}
              {sel?.status === 'failed' && (
                <Box flexDirection="column" borderStyle="single" borderColor={theme.error} paddingX={1} marginTop={1}>
                  <Text bold color={theme.error}>failed — turn it into a decision:</Text>
                  <Text color={theme.textSecondary}>[1] reroute same prompt to a local provider (no credits needed)</Text>
                  <Text color={theme.textSecondary}>[2] log a top-up note to .timmy/notes.md</Text>
                </Box>
              )}
              {note && <Text color={theme.success} wrap="truncate">{note}</Text>}
            </>
          ) : (
            <Text color={theme.textSecondary}>select a generation, or [p] to queue one.</Text>
          )}
          {composing && (() => {
            const winStart = Math.max(0, Math.min(provIdx - 4, Math.max(0, providers.length - 9)));
            const win = providers.slice(winStart, winStart + 9);
            const opts = optionsFor(prov.id);
            const opt = opts.length ? opts[optIdx % opts.length] : undefined;
            return (
              <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.info} paddingX={1}>
                <Text bold color={theme.info}>PROVIDER — ↑↓ like the chat model rail · ] option</Text>
                {win.map((p, i) => {
                  const isSel = winStart + i === provIdx;
                  const pOpts = optionsFor(p.id);
                  const pOpt = isSel && pOpts.length ? pOpts[optIdx % pOpts.length] : undefined;
                  return (
                    <Text key={p.id} color={isSel ? theme.brand : theme.textSecondary} bold={isSel} wrap="truncate">
                      {isSel ? '▶ ' : '  '}{p.kind === 'video' ? '🎞️' : '🖼️'} {p.id.padEnd(20)} {p.modelId || ''}{pOpt ? ` · opt: ${pOpt.label}` : ''}
                    </Text>
                  );
                })}
                <Text>prompt: {draft}█</Text>
                <Text color={theme.textSecondary}>{opt ? `option ${opt.label} rides the prompt · ` : ''}Enter queues (real credits if launched) · Esc cancels</Text>
              </Box>
            );
          })()}
        </Box>
      </Box>
    </PanelFrame>
  );
}
