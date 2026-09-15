import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { PaneFocusContext } from '../components/PanelFrame.js';
import { KeyHintBar } from '../components/KeyHintBar.js';
import { Card, BudgetList, EmptyState } from '../ui/index.js';
import { listClipJobs, createClipJob, detectClip, ffmpegCheat, CLIP_INSTALL, type ClipJob } from '../../utils/clip.js';
import { runClipJob } from '../../utils/cliprunner.js';
import { listProjects } from '../../utils/projects.js';
import { BRAND } from '../../utils/brand.js';
import { osc52Copy } from '../../utils/notify.js';
import { theme } from '../theme.js';

interface ClipPanelProps {
  agent: any;
  setInspector?: (s: string | null) => void;
  zone?: number;
  setZone?: (z: number) => void;
  setModalInput?: (b: boolean) => void;
  inputLocked?: boolean;
}

/**
 * TIMMY Clip — the video-editing tab. Lists receipt-linked clip manifests;
 * the actual cutting happens via open-edit (agent-driven, Apple Silicon) or
 * the deterministic ffmpeg one-liners ([y] yanks them). TIMMY never pretends
 * to be a timeline GUI: it links generations, writes the runbook, seals proof.
 */
export function ClipPanel({ zone = 0, setZone, setModalInput, inputLocked }: ClipPanelProps) {
  const [jobs, setJobs] = useState<ClipJob[]>([]);
  const [idx, setIdx] = useState(0);
  const [composing, setComposing] = useState(false);
  const [projIdx, setProjIdx] = useState(0);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const focused = React.useContext(PaneFocusContext);

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setJobs(listClipJobs()); }, [tick]);

  const sel = jobs[Math.min(idx, Math.max(0, jobs.length - 1))];
  const projects = listProjects();
  const st = detectClip();

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:clip')) return;
    if (zone < 0) return;
    if (composing) {
      if (key.escape) { setComposing(false); setDraft(''); __focus.release('input:clip'); return; }
      if (key.upArrow) { setProjIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setProjIdx(i => Math.min(Math.max(0, projects.length - 1), i + 1)); return; }
      if (key.return) {
        const p = projects[projIdx];
        if (p) {
          const job = createClipJob(p, draft.trim() || 'assemble the beats in order', []);
          setNote(`${job.id} queued for ${p} — link sources from SLATE [c] for receipted provenance`);
        }
        setComposing(false);
        setDraft('');
        __focus.release('input:clip');
        return;
      }
      if (key.backspace || key.delete) { setDraft(d => d.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) setDraft(d => d + char);
      return;
    }
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(Math.max(0, jobs.length - 1), i + 1)); return; }
    if (key.leftArrow) { setZone?.(Math.max(-1, zone - 1)); return; }
    if (key.rightArrow) { setZone?.(Math.min(1, zone + 1)); return; }
    const c = char.toLowerCase();
    if (c === 'n') { setComposing(true); __focus.claim('input:clip'); return; }
    if (c === 'o' && sel) { setNote(`in your terminal: ${process.env.EDITOR || 'nvim'} ${sel.output.replace(/\.mp4$/, '.md')}`); return; }
    if (c === 'y' && sel?.sources[0]) {
      osc52Copy(ffmpegCheat(sel.sources[0].artifact).join('\n'));
      setNote('ffmpeg one-liners yanked (probe/cut/compress/audio)');
      return;
    }
    if (c === 'r' && sel) {
      const r = runClipJob(sel);
      setNote(r.ok ? `sealed ${r.receiptHash?.slice(0, 18)} — run dir under .timmy/runs/` : `run failed: ${r.note}`);
      return;
    }
  }, { isActive: !inputLocked });

  const jobIdx = Math.min(idx, Math.max(0, jobs.length - 1));

  return (
    <Card
      title={`${BRAND.clip} — video editing`}
      focused={focused}
      purpose={BRAND.clipTagline.charAt(0).toLowerCase() + BRAND.clipTagline.slice(1)}
      pill={{
        kind: st.dir ? 'accent' : 'warn',
        label: `${jobs.length} job${jobs.length === 1 ? '' : 's'}${st.dir ? '' : ' · open-edit missing'}`
      }}
      flexGrow={1}
    >
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width="42%" paddingRight={1}>
          {jobs.length === 0 ? (
            <EmptyState line="no clip jobs yet" action="[n] here, or SLATE [c] on a project" />
          ) : (
            <BudgetList
              items={jobs}
              max={7}
              offset={Math.max(0, jobIdx - 6)}
              render={(j, i) => {
                const isSel = i === jobIdx;
                return (
                  <Text key={j.id} color={isSel ? theme.accent : theme.textSecondary} bold={isSel} wrap="truncate">
                    {isSel ? '▸ ' : '  '}{j.id} · {j.project} · {j.sources.length} src · {j.status}
                  </Text>
                );
              }}
            />
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {sel ? (
            <>
              <Text bold color={theme.accent} wrap="truncate">{sel.id} · {sel.project}</Text>
              <Text color={theme.textSecondary} wrap="wrap">instruction: {sel.instruction}</Text>
              <Box marginTop={1} flexDirection="column">
                {sel.sources.map((s, si) => (
                  <Text key={`${si}-${s.genId}-${s.artifact}`} color={theme.textSecondary} wrap="truncate">
                    · {s.label} → {s.artifact}{s.receiptHash ? ` · receipt ${s.receiptHash.slice(7, 19)}` : ''}
                  </Text>
                ))}
                {sel.sources.length === 0 && <Text color={theme.textSecondary}>· no linked sources — SLATE [c] links gens with receipt hashes</Text>}
              </Box>
              <Text color={theme.textPrimary} wrap="truncate">out: {sel.output}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color={theme.textSecondary}>deterministic layer ([y] yanks these):</Text>
                {ffmpegCheat(sel.sources[0]?.artifact ?? sel.output).slice(1).map((l, li) => (
                  <Text key={`${li}-${l}`} color={theme.textSecondary} wrap="truncate">  {l}</Text>
                ))}
              </Box>
              {!st.dir && <Text color={theme.textMuted} wrap="truncate">agent layer: {st.note ?? CLIP_INSTALL}</Text>}
              {note && <Text color={theme.accent} wrap="truncate">{note}</Text>}
            </>
          ) : (
            <EmptyState line="select a job, or [n] to queue one" />
          )}
          {composing && (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.accent}>new clip job — ↑↓ project · instruction:</Text>
              <Text>{projects[projIdx] ?? '(no projects)'} ▸ {draft}█</Text>
              <Text color={theme.textSecondary}>Enter queues · Esc cancels</Text>
            </Box>
          )}
        </Box>
      </Box>
      <KeyHintBar hints={[
        { key: '↑↓', label: 'job' },
        { key: 'n', label: 'new job' },
        { key: 'r', label: 'run headless + seal' },
        { key: 'o', label: 'runbook in $EDITOR' },
        { key: 'y', label: 'yank ffmpeg lines' }
      ]} />
    </Card>
  );
}
