import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Card } from './ui/Card.js';
import { useFocusOptional } from './hooks/useKeyDispatcher.js';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import type { Agent } from '../agent/core.js';
import { saveConfig } from '../utils/config.js';
import { applySetup } from '../utils/init.js';
import { prettyPath, setupPath } from '../setup/home.js';
import { effectiveAnswers, needsAsking, pendingQuestions, QUESTIONS, readSetupState, setupSummary, type Answers, type Chat, type Logs, type Question, type QuestionId, type SetupState } from '../setup/questions.js';
import { answersWords } from '../setup/terminal.js';
import { theme } from './theme.js';

interface OnboardingProps {
  /** v1 shell: its agent learns a key typed here */
  agent?: Agent;
  /** the setup is done: one line of what it chose */
  onDone: (summary: string) => void;
  /**
   * R4 (H87): leave the monitor from this screen (q or Esc on the first page: 0; Ctrl+C anywhere: 130). The caller ends the
   * process; Ink's exit alone ended only the screen and left the monitor running in a canonical, echoing terminal (r23b).
   */
  onQuit?: (code: number) => void;
  /** R4 (H98): the legacy v1 shell's three teach steps after the questions (its keys); the monitor (v2) has none */
  teach?: boolean;
  /** who answers, as setup.json records it */
  by?: string;
}

/** R4 (H87): a command's exit, without blocking the screen (the setup's checks used to run in its first render). */
const succeeds = (cmd: string, args: string[], ms: number, ok: (stdout: string) => boolean = () => true): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (err, stdout) => {
        try { resolve(!err && ok(String(stdout))); } catch { resolve(false); }
      });
    } catch { resolve(false); }
  });

/** The same facts as src/utils/doctor.ts checkDocker and checkComfyCli, asked without blocking the keys. */
async function degradedDeps(): Promise<string> {
  const [docker, comfy] = await Promise.all([
    // Older Docker clients can exit 0 after an API error with --format: a server version is the answer
    succeeds('docker', ['info', '--format', '{{json .ServerVersion}}'], 5000, (out) => { const v: unknown = JSON.parse(out); return typeof v === 'string' && v.trim().length > 0; }),
    succeeds('comfy', ['--json', 'env'], 15000).then((ok) => ok || existsSync(join(homedir(), '.local', 'bin', 'comfy'))),
  ]);
  const bad = [...(docker ? [] : ['docker down']), ...(comfy ? [] : ['comfy-cli missing'])];
  return bad.length ? `degraded deps: ${bad.join(' · ')} — TIMMY still runs; lanes fail closed honestly` : '';
}

type Step = 'splash' | 'ask' | 'confirm' | 'teachMission' | 'teachPalette' | 'teachBack';

// Clearinghouse wordmark: accent → text ramp down the rows (DESIGN.md §2)
const WORDMARK = [
  '████████ ██ ███    ███ ███    ███ ██    ██',
  '   ██    ██ ████  ████ ████  ████  ██  ██ ',
  '   ██    ██ ██ ████ ██ ██ ████ ██   ████  ',
  '   ██    ██ ██  ██  ██ ██  ██  ██    ██   ',
  '   ██    ██ ██      ██ ██      ██   ██    '
];
// C-11: the wordmark's ramp is weight only (bold, bold, then regular): B3 bans dim, and grey-3
// read 5.09:1 on an audited #191919 ground
const MARK_COLORS = [theme.accent, theme.accent, theme.textPrimary, theme.textSecondary, theme.textMuted];

/** The next question to ask after `after` (null: from the first), given the answers so far; null when none is left. */
function nextQuestion(s: SetupState, given: Answers, after: QuestionId | null): Question | null {
  const a = effectiveAnswers(s, given);
  const from = after === null ? 0 : QUESTIONS.findIndex((q) => q.id === after) + 1;
  for (const q of QUESTIONS.slice(from)) if (needsAsking(q, s, a, given)) return q;
  return null;
}

/**
 * The monitor's FIRST RUN (R4 H98): Timmy's one guided setup (src/setup), the same questions `timmy init` asks, in the
 * same words, asked only while they have no answer; the local model and local-only logs are preselected, and the paid and
 * cloud choices say so. The answers are written to the Timmy home by the same writer (applySetup). Before, this screen had
 * questions of its own (a brain, a key, Cloudflare log sync, the archive) with cloud defaults, after `timmy init` had
 * asked its own (r24). Keys: on the first page Enter begins, q or Esc leaves; on a question a choice's key selects it, the
 * arrows move, Enter goes on, Esc goes back; q is a letter there. Ctrl+C ends the monitor anywhere (130).
 */
export function Onboarding({ agent, onDone, onQuit, teach = false, by = 'the monitor' }: OnboardingProps) {
  const { exit } = useApp();
  const quit = (code: number): void => { if (onQuit) onQuit(code); else exit(); };
  const focus = useFocusOptional();
  // sovereign permitted leaf: hold the stack while mounted; pop is structural
  useEffect(() => {
    focus?.claim('modal:onboarding');
    return () => focus?.release('modal:onboarding');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // what the home holds, read once: the questions without an answer
  const [state] = useState<SetupState>(() => readSetupState());
  const [step, setStep] = useState<Step>('splash');
  // R4 (H87): checked after the screen is up, without blocking it (they took up to 20 s in its first render)
  const [envNote, setEnvNote] = useState('');
  useEffect(() => {
    let live = true;
    void degradedDeps().then((note) => { if (live) setEnvNote(note); }, () => undefined);
    return () => { live = false; };
  }, []);
  const [answers, setAnswers] = useState<Answers>({});
  const [asked, setAsked] = useState<QuestionId[]>([]);
  const [current, setCurrent] = useState<Question | null>(null);
  const [typed, setTyped] = useState('');
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [summary, setSummary] = useState('');

  const pending = useMemo(() => pendingQuestions(state), [state]);
  const open = (q: Question | null, given: Answers): void => {
    setNote('');
    setTyped('');
    if (!q) { setCurrent(null); setStep('confirm'); return; }
    setCurrent(q);
    setSelected(q.kind === 'choice' ? q.preselect(effectiveAnswers(state, given), state) : '');
    setStep('ask');
  };
  const back = (): void => {
    setNote('');
    const prev = asked[asked.length - 1];
    if (!prev) { setCurrent(null); setStep('splash'); return; }
    const given = { ...answers };
    delete (given as Record<string, unknown>)[prev];
    setAnswers(given);
    setAsked(asked.slice(0, -1));
    open(QUESTIONS.find((q) => q.id === prev) ?? null, given);
  };
  const answer = (q: Question, raw: string): void => {
    const r = q.read(raw, effectiveAnswers(state, answers), state);
    if (!r.ok) { setNote(r.why); return; }
    const given: Answers = { ...answers };
    if (q.id === 'chat') given.chat = r.value as Chat;
    else if (q.id === 'logs') given.logs = r.value as Logs;
    else (given as Record<string, string>)[q.id] = r.value;
    setAnswers(given);
    setAsked([...asked, q.id]);
    open(nextQuestion(state, given, q.id), given);
  };
  const save = (): void => {
    try {
      applySetup(answers, { by, state });
    } catch (e) {
      setNote(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // the monitor's own settings remember that its first run is done (the answers themselves are in the Timmy home)
    try { saveConfig({ onboarded: true } as never); } catch { /* the setup itself is saved */ }
    if (answers.key) { try { agent?.updateApiKey(answers.key); } catch { /* client refresh best-effort */ } }
    const words = setupSummary(readSetupState());
    setSummary(words);
    if (teach) setStep('teachMission');
    else onDone(words);
  };

  useInput((char, key) => {
    // R4 (H87): Ctrl+C ends the monitor from any step of the setup (130), as everywhere else in it
    if (key.ctrl && char === 'c') { quit(130); return; }
    const enter = key.return || char === '\n';
    if (step === 'splash') {
      // Enter begins; a '\n' (Ctrl+J, or Enter typed while the terminal was still line by line) too
      if (enter) { if (pending.length) open(nextQuestion(state, {}, null), {}); else if (teach) setStep('teachMission'); else onDone(setupSummary(state)); return; }
      if (char === 'q' || key.escape) quit(0);
      return;
    }
    if (step === 'teachMission') {
      if (char === '2') { setNote(''); setStep('teachPalette'); }
      else if (char && !key.ctrl && !key.meta) setNote('not that one — press [2] to open MISSION');
      return;
    }
    if (step === 'teachPalette') {
      if (key.ctrl && char === 'k') { setNote(''); setStep('teachBack'); }
      else if (char && !key.ctrl && !key.meta) setNote('not that one — press [^K] to open the palette');
      return;
    }
    if (step === 'teachBack') {
      if (char === '1') { setNote(''); onDone(summary || setupSummary(readSetupState())); }
      else if (char && !key.ctrl && !key.meta) setNote('not that one — press [1] to return to COMMAND');
      return;
    }
    if (step === 'confirm') {
      if (enter) { save(); return; }
      if (key.escape) back();
      return;
    }
    if (step === 'ask' && current) {
      if (key.escape) { back(); return; }
      if (current.kind === 'choice') {
        const choices = current.choices ?? [];
        const at = choices.findIndex((c) => c.value === selected);
        if (enter) { answer(current, selected); return; }
        if (key.upArrow) { setSelected(choices[Math.max(0, at - 1)].value); return; }
        if (key.downArrow) { setSelected(choices[Math.min(choices.length - 1, at + 1)].value); return; }
        const c = choices.find((x) => x.key === char);
        if (c) { setSelected(c.value); setNote(''); }
        return;
      }
      if (enter) { answer(current, typed); return; }
      if (key.backspace || key.delete) { setTyped(typed.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta && char !== '\t') setTyped(typed + char.replace(/[\r\n]/g, ''));
    }
  });

  const given = effectiveAnswers(state, answers);
  const index = asked.length + 1;
  const total = asked.length + pendingQuestions(state, answers).length;
  const where = `${prettyPath(setupPath())} (the Timmy home)`;
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Card
        title="TIMMY · FIRST RUN"
        focused
        purpose="the questions timmy init asks · local first · no account needed"
        pill={{ kind: 'accent', label: 'SETUP' }}
      >
        {step === 'splash' && (
          <Box flexDirection="column">
            {WORDMARK.map((l, i) => <Text key={i} bold={i < 2} color={MARK_COLORS[i]}>{l}</Text>)}
            <Text bold color={theme.accent}>Terminal-first Agent Trust OS — Flight Recorder for AI Agent Runs</Text>
            <Text color={theme.textSecondary}>Every action seals a cryptographic receipt. Targets are not receipts.</Text>
            {pending.length ? (
              <Text color={theme.textPrimary} wrap="wrap">{`${pending.length === 1 ? 'One setup question has' : `${pending.length} setup questions have`} no answer yet: ${pending.map((q) => q.title.replace(/ \(.*\)$/, '')).join(', ')}. The same ones timmy init asks; the answers are saved in ${where}.`}</Text>
            ) : (
              <Text color={theme.textPrimary} wrap="wrap">{`Every setup question has an answer: ${setupSummary(state)}.`}</Text>
            )}
            {envNote && <Text color={theme.warn}>{envNote}</Text>}
            <Text color={theme.textMuted}>[Enter] Begin setup · [q] or [Esc] Quit</Text>
          </Box>
        )}
        {step === 'ask' && current && (
          <Box flexDirection="column">
            <Text color={theme.textSecondary}>{`question ${index} of ${Math.max(index, total)} · nothing is saved until the end`}</Text>
            <Box height={1} />
            <Text bold color={theme.textPrimary}>{current.title}</Text>
            {current.kind === 'choice' ? (current.choices ?? []).map((c) => (
              <Box key={c.key} flexDirection="column">
                <Text color={c.value === selected ? theme.accent : theme.textPrimary}>{`${c.value === selected ? '  ▸' : '  ◇'} [${c.key}] ${c.label}`}</Text>
                <Box paddingLeft={8}><Text color={theme.textSecondary} wrap="wrap">{c.note}</Text></Box>
              </Box>
            )) : (
              <Box paddingX={1}>
                <Text color={theme.accent}>▸ </Text>
                {typed
                  ? <Text color={theme.textPrimary}>{current.kind === 'secret' ? '*'.repeat(typed.length) : typed}</Text>
                  : <Text color={theme.textMuted}>{current.preselect(given, state) ? `Enter keeps ${current.preselect(given, state)}` : current.kind === 'secret' ? 'hidden as you type' : 'Enter: none'}</Text>}
              </Box>
            )}
            <Box height={1} />
            <Text color={theme.textMuted}>{current.kind === 'choice'
              ? `[${(current.choices ?? []).map((c) => c.key).join('/')}] choose · [Enter] next · [Esc] back · Ctrl+C quits`
              : '[Enter] next · [Esc] back · Ctrl+C quits'}</Text>
          </Box>
        )}
        {step === 'confirm' && (
          <Box flexDirection="column">
            <Text bold color={theme.textPrimary}>Save these answers?</Text>
            <Text color={theme.textPrimary} wrap="wrap">{answersWords(given, state) || setupSummary(state)}</Text>
            <Text color={theme.textSecondary} wrap="wrap">{`Written only to ${prettyPath(state.home)}/ and ${prettyPath(state.privateDir)}/ (the receipts store pin too, the first time).`}</Text>
            <Box height={1} />
            <Text color={theme.textMuted}>[Enter] save · [Esc] back · Ctrl+C quits</Text>
          </Box>
        )}
        {step === 'teachMission' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.textSecondary} wrap="wrap">{`Saved: ${summary}`}</Text>
            <Text bold color={theme.accent}>◆ TEACH 1/3 — press [2] MISSION (DAG + capsules)</Text>
            <Text color={theme.textMuted}>wrong keys are swallowed with a gentle hint</Text>
          </Box>
        )}
        {step === 'teachPalette' && (
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text bold color={theme.accent}>◆ TIMMY COMMAND PALETTE — solid overlay, numbered rows</Text>
            <Text color={theme.textSecondary}> 1. model · local qwen (on-device)</Text>
            <Text color={theme.textMuted}>◆ TEACH 2/3 — press [^K] to open it for real</Text>
          </Box>
        )}
        {step === 'teachBack' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={theme.accent}>◆ TEACH 3/3 — press [1] to return to COMMAND</Text>
          </Box>
        )}

        {note && <Text color={theme.warn} wrap="wrap">{note}</Text>}
        <Box marginTop={1}>
          <Text color={theme.textSecondary}>TIMMY never sells compute: your keys, your Ollama, your worker. We store proofs, not your traffic.</Text>
        </Box>
      </Card>
    </Box>
  );
}
