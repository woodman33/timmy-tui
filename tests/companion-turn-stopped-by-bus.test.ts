/**
 * R7 (H152; the R5 visual review's 13: the companion's mirror rows did not say who stopped a turn): a chat turn sealed
 * stopped, asked from another surface, publishes who asked (its receipt's stopped_by) on the event bus beside its turn_id
 * (src/utils/receipts.ts), so the companion's mirror row says it at once ("stopped (asked from the companion)") instead of
 * only after its next read of the frame; a turn stopped where it was sent, or answered, publishes none.
 *
 * Real: the sealer (src/repl/seal.ts sealTurn, as every surface seals a turn), the receipt chain and the bus file, in a temp
 * project. FIXTURE: the turns' facts (no model was asked).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { busPath } from '../src/bus/index.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('a stopped turn\'s receipt names who asked on the bus (R7 H152)', () => {
  it('stopped_by on receipt.sealed when another surface asked; none when the turn stopped where it was sent, or was answered', () => {
    const project = mkdtempSync(join(tmpdir(), 'turn-stopped-by-bus-'));
    dirs.push(project);
    mkdirSync(join(project, '.timmy', 'receipts'), { recursive: true });
    const base = { prompt: 'FIXTURE prompt, never shown', answer: '', steps: 0, spend: 0, costMeasured: false, ms: 500, model: 'fixture:1b', project: 'FIXTURE', projectId: projectId(project) };
    const asked = sealTurn({ ...base, status: 'cancelled', cancelledAt: 'before-tools', stoppedBy: 'companion', surface: 'workbench' }, project);
    const own = sealTurn({ ...base, status: 'cancelled', cancelledAt: 'before-tools', surface: 'repl' }, project);
    const answered = sealTurn({ ...base, answer: 'FIXTURE answer', status: 'ok', surface: 'repl' }, project);
    const sealed = readFileSync(busPath(project), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> })
      .filter((e) => e.kind === 'receipt.sealed');
    const of = (id: string) => sealed.find((e) => String(e.payload.hash).slice(7, 15) === id)?.payload;
    expect(of(asked.id)).toMatchObject({ kind: 'chat', stopped_by: 'companion' });
    expect(of(own.id)).toMatchObject({ kind: 'turn' });
    expect(of(own.id)).not.toHaveProperty('stopped_by');
    expect(of(answered.id)).not.toHaveProperty('stopped_by');
  });
});
