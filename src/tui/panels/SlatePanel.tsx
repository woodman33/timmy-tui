import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Agent } from '../../agent/core.js';
import { PanelFrame } from '../components/PanelFrame.js';
import { listProjects, readProject, initProject, saveProject, renderProjectSite, renderCanvasPage, type SlateProject } from '../../utils/projects.js';
import { listTemplates, loadTemplate } from '../../utils/templates.js';
import { ensureDashServer } from '../../utils/dash.js';
import { seedStarter } from '../../utils/starter.js';
import { createClipJob, detectClip } from '../../utils/clip.js';
import { BRAND } from '../../utils/brand.js';
import { theme } from '../theme.js';

interface SlatePanelProps {
  agent: Agent;
  setInspector?: (s: string | null) => void;
  zone?: number;
  setZone?: (z: number) => void;
  setModalInput?: (b: boolean) => void;
  inputLocked?: boolean;
}

interface SlateItem { kind: 'project' | 'template'; name: string; }

/**
 * SLATE — the TIMMY visual language console. Left: projects + templates.
 * Right: storyboard beats, refs, gens. [c] opens the live canvas/site in a
 * carbonyl pane (your tldraw on localhost, or the published project site).
 * The terminal authors; the canvas renders. One schema, many targets.
 */
export function SlatePanel({ agent, zone = 0, setZone, setModalInput, inputLocked }: SlatePanelProps) {
  const [items, setItems] = useState<SlateItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [naming, setNaming] = useState(false);
  const [using, setUsing] = useState(false);
  const [clipping, setClipping] = useState(false);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const load = () => {
      seedStarter();
      setItems([
        ...listProjects().map(name => ({ kind: 'project' as const, name })),
        ...listTemplates().map(name => ({ kind: 'template' as const, name }))
      ]);
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const sel = items[Math.min(idx, Math.max(0, items.length - 1))];
  const proj = sel?.kind === 'project' ? readProject(sel.name) : null;
  const tmpl = sel?.kind === 'template' ? loadTemplate(sel.name, '{brief}') : null;

  const openCanvas = (item: SlateItem) => {
    ensureDashServer();
    if (item.kind === 'project') renderCanvasPage(item.name);
    const url = item.kind === 'project'
      ? `http://127.0.0.1:4273/studio/${item.name}/site/canvas.html`
      : (process.env.TIMMY_SLATE_URL || 'http://127.0.0.1:5173/');
    agent.addBrowserPane(url);
  };

  const openSite = (item: SlateItem) => {
    ensureDashServer();
    if (item.kind === 'project') renderProjectSite(item.name);
    agent.addBrowserPane(`http://127.0.0.1:4273/studio/${item.name}/site/index.html`);
  };

  useInput((char, key) => {
    if (zone < 0) return; // nav owns the keyboard
    if (naming) {
      if (key.escape) { setNaming(false); setDraft(''); setModalInput?.(false); return; }
      if (key.return) {
        const name = draft.trim().replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
        if (name) initProject(name);
        setNaming(false);
        setDraft('');
        setModalInput?.(false);
        return;
      }
      if (key.backspace || key.delete) { setDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setDraft(d => d + char);
      return;
    }
    if (using) {
      if (key.escape) { setUsing(false); setDraft(''); setModalInput?.(false); return; }
      if (key.return && sel) {
        const idea = draft.trim() || sel.name;
        const name = idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'proj';
        initProject(name, { template: sel.kind === 'template' ? sel.name : undefined });
        if (sel.kind === 'template') {
          const t = loadTemplate(sel.name, idea);
          const proj = readProject(name);
          if (proj) {
            proj.beats = t.beats;
            proj.kind = (t as { kind?: SlateProject['kind'] }).kind;
            saveProject(proj);
          }
        }
        setUsing(false);
        setDraft('');
        setModalInput?.(false);
        return;
      }
      if (key.backspace || key.delete) { setDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setDraft(d => d + char);
      return;
    }
    if (clipping) {
      if (key.escape) { setClipping(false); setDraft(''); setModalInput?.(false); return; }
      if (key.return && sel?.kind === 'project') {
        const p = readProject(sel.name);
        const sources = (p?.gens || [])
          .filter(g => g.artifact)
          .map(g => ({ genId: g.id, label: g.label, artifact: g.artifact as string }));
        const job = createClipJob(sel.name, draft.trim() || 'assemble the beats in order, cut to the call sheet', sources);
        const st = detectClip();
        setNote(`${BRAND.clip}: ${job.id} → ${sel.name}/clips/ · ${sources.length} linked gens${st.dir ? '' : ` · open-edit missing (${st.note})`}`);
        setClipping(false);
        setDraft('');
        setModalInput?.(false);
        return;
      }
      if (key.backspace || key.delete) { setDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setDraft(d => d + char);
      return;
    }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(Math.max(0, items.length - 1), i + 1)); return; }
    // ONE GRAMMAR: ←→ move between panes (nav ↔ list ↔ detail)
    if (key.leftArrow) { setZone?.(Math.max(-1, zone - 1)); return; }
    if (key.rightArrow) { setZone?.(Math.min(1, zone + 1)); return; }
    const c = char.toLowerCase();
    // Enter ALWAYS selects: use a template, open a project
    if (key.return && sel) {
      if (sel.kind === 'template') { setUsing(true); setModalInput?.(true); return; }
      openCanvas(sel);
      return;
    }
    if (c === 'n') { setNaming(true); setModalInput?.(true); return; }
    if (char === 'P' && sel?.kind === 'project') {
      const site = renderProjectSite(sel.name);
      if (site) ensureDashServer();
      return;
    }
    if (c === 'v' && sel) { openCanvas(sel); return; }
    if (c === 'o' && sel) { openSite(sel); return; }
    if (c === 'c' && sel?.kind === 'project') { setClipping(true); setModalInput?.(true); return; }
  }, { isActive: !inputLocked });

  return (
    <PanelFrame
      icon="📐"
      title="SLATE DAG & STORYBOARDS"
      status={`${listProjects().length} projects · ${listTemplates().length} templates`}
      statusColor={theme.brand}
      explain="Author storyboards + projects in the terminal; watch them live in a carbonyl canvas. One schema → HyperFrames, sites, tldraw."
      hints={[
        { key: '↑↓', label: 'select' },
        { key: '↵', label: 'use template / open' },
        { key: 'n', label: 'new project' },
        { key: 'P', label: 'publish site' },
        { key: 'c', label: 'TIMMY Clip job' },
        { key: 'v', label: 'canvas pane' },
        { key: 'o', label: 'site pane' }
      ]}
    >
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width="38%" paddingRight={1} borderStyle="single" borderColor={zone === 0 ? theme.brand : theme.borderDefault}>
          {items.length === 0 && (
            <Box flexDirection="column">
              <Text color={theme.textSecondary}>no projects yet.</Text>
              <Text color={theme.textSecondary}>[n] creates one; templates seed from /studio.</Text>
            </Box>
          )}
          {items.map((it, i) => (
            <Text key={`${it.kind}-${it.name}`} color={i === Math.min(idx, items.length - 1) ? theme.brand : theme.textPrimary} bold={i === Math.min(idx, items.length - 1)} wrap="truncate">
              {i === Math.min(idx, items.length - 1) ? '▶ ' : '  '}{it.kind === 'project' ? '📁' : '📐'} {it.name}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {proj && (
            <>
              <Text bold color={theme.brand}>📁 {proj.name}</Text>
              <Text color={theme.textSecondary}>{proj.created_at.replace('T', ' ').slice(0, 16)} · template: {proj.template || '—'}</Text>
              <Text color={theme.textSecondary}>{proj.refs.length} refs · {proj.gens.length} gens</Text>
              {(proj.beats || []).map((b, i) => (
                <Text key={i} color={theme.textSecondary} wrap="truncate">• {b.at}s–{b.at + b.dur}s [{b.label}] {b.text}</Text>
              ))}
              {proj.gens.slice(-4).map(g => (
                <Text key={g.id} color={theme.textSecondary} wrap="truncate">  🎬 {g.label} · {g.provider}{g.artifact ? ` → ${g.artifact}` : ''}</Text>
              ))}
              <Text color={theme.textSecondary}>[P] renders site/ · [c] {BRAND.clip} · [v] canvas · [o] site pane</Text>
              {note && <Text color={theme.success} wrap="truncate">{note}</Text>}
            </>
          )}
          {tmpl && (
            <>
              <Text bold color={theme.brand}>📐 {tmpl.name} ({tmpl.source}, {tmpl.total}s)</Text>
              {tmpl.beats.map((b, i) => (
                <Text key={i} color={theme.textSecondary} wrap="truncate">• {b.at}s–{b.at + b.dur}s [{b.label}] {b.text}</Text>
              ))}
              <Text color={theme.textSecondary}>use with /studio --template {tmpl.name} &lt;idea&gt;</Text>
              <Text color={theme.textSecondary}>[v] opens your tldraw Slate canvas (TIMMY_SLATE_URL)</Text>
            </>
          )}
          {!proj && !tmpl && <Text color={theme.textSecondary}>select a project or template.</Text>}
          {naming && (
            <Box marginTop={1} borderStyle="single" borderColor={theme.info} paddingX={1}>
              <Text color={theme.info}>new project name: {draft}█</Text>
            </Box>
          )}
          {clipping && sel && (
            <Box marginTop={1} borderStyle="single" borderColor={theme.info} paddingX={1} flexDirection="column">
              <Text color={theme.info}>{BRAND.clip} — edit instruction (links this project's gens into an open-edit job):</Text>
              <Text>{draft}█</Text>
              <Text color={theme.textSecondary}>Enter writes clips/&lt;id&gt;.json + .md (receipt-linked sources) · Esc cancels</Text>
            </Box>
          )}
          {using && sel && (
            <Box marginTop={1} borderStyle="single" borderColor={theme.info} paddingX={1} flexDirection="column">
              <Text color={theme.info}>use template "{sel.name}" — idea (becomes the project name + brief):</Text>
              <Text>{draft}█</Text>
              <Text color={theme.textSecondary}>Enter creates the project with the template's beats · Esc cancels</Text>
            </Box>
          )}
        </Box>
      </Box>
    </PanelFrame>
  );
}
