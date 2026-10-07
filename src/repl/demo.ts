/**
 * `timmy repl --demo` (playbook §17.9): the real renderer driven by one scripted turn, with no
 * network and no model. Committed output is deterministic: two runs capture byte for byte the same.
 */
import type { TurnEvent } from './transcript.js';

export interface DemoStep {
  event: TurnEvent;
  delayMs: number;
}

const step = (delayMs: number, event: TurnEvent): DemoStep => ({ delayMs, event });
const lanes = (states: Array<'done' | 'running' | 'waiting'>): TurnEvent => ({
  type: 'lanes',
  lanes: ['Write the script', 'Draw the storyboard', 'Record the voiceover'].map((label, i) => ({ label, state: states[i] })),
});

export const DEMO_TURN: DemoStep[] = [
  step(0, { type: 'prompt', text: 'Make a 20-second storyboard for the launch video', cwd: '~/timmy/launch-video' }),
  step(150, { type: 'thinking' }),
  step(600, { type: 'text', id: 'm1', text: "I'll plan this as three lanes" }),
  step(120, { type: 'text', id: 'm1', text: "I'll plan this as three lanes and keep every step on the receipt." }),
  step(150, lanes(['running', 'waiting', 'waiting'])),
  step(150, { type: 'tool-start', id: 't1', tool: 'file_read', args: { path: 'brief.md' } }),
  step(200, { type: 'tool-end', id: 't1', ok: true, preview: 'Launch video: 20 seconds, upbeat, end on the receipt chain.' }),
  step(100, { type: 'tool-start', id: 't2', tool: 'file_read', args: { path: 'assets/logo.svg' } }),
  step(150, { type: 'tool-end', id: 't2', ok: true }),
  step(100, { type: 'tool-start', id: 't3', tool: 'file_edit', args: { path: 'script.md' } }),
  step(300, {
    type: 'tool-end',
    id: 't3',
    ok: true,
    diff: '@@ -1,3 +1,3 @@\n # Launch video\n-Open on the logo.\n+Open on a receipt sealing in real time.\n End on the chain.',
  }),
  step(150, lanes(['done', 'running', 'waiting'])),
  step(150, { type: 'tool-start', id: 't4', tool: 'generate_storyboard', args: { path: 'storyboard.json' } }),
  step(900, { type: 'tool-end', id: 't4', ok: true, preview: '6 frames, 20.0 seconds, 16:9' }),
  step(100, { type: 'tool-start', id: 't5', tool: 'shell', args: { command: 'ffmpeg -framerate 0.3 -i frames/%02d.png storyboard.mp4' } }),
  step(1200, { type: 'tool-end', id: 't5', ok: true, preview: 'storyboard.mp4  20.0s  1920x1080' }),
  step(150, lanes(['done', 'done', 'running'])),
  step(150, { type: 'tool-start', id: 't6', tool: 'tts', args: { path: 'voiceover.wav' } }),
  step(900, { type: 'tool-end', id: 't6', ok: true, preview: 'voiceover.wav  18.6s' }),
  step(150, lanes(['done', 'done', 'done'])),
  step(150, { type: 'text', id: 'm2', text: 'The storyboard and the voiceover are ready in ~/timmy/launch-video.' }),
  step(150, { type: 'receipt', id: '0142', verified: true, lanes: 3, steps: 6, spend: '$0.42', seconds: 41 }),
];

/** Holds the loader for about 10 seconds, so its frames and the elapsed time can be captured. */
export const DEMO_LOADER: DemoStep[] = [
  step(0, { type: 'prompt', text: 'Render the storyboard at 4K', cwd: '~/timmy/launch-video' }),
  step(100, { type: 'thinking' }),
  step(10_000, { type: 'text', id: 'm1', text: 'Done waiting.' }),
];
