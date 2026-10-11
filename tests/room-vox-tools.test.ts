/**
 * Round R4 (H65, H61's note in ledger row 160): the Control Room's tools panel draws VoxVision's own /tools rows as a group of
 * their own (they were folded under "everything else"), while /room's needs-setup line counts them with the other rows as
 * before. The rows are VoxVision's real ones (src/vox/tools.ts voxCapabilityRows) for an empty environment with nothing on
 * PATH; the other rows are FAKE /tools rows, labelled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { needsSetup, setupCounts, toolGroups, type RoomView } from '../src/room/index.js';
import { toolsPanel } from '../src/repl/board-room.js';
import { kit } from '../src/repl/board-kit.js';
import { voxCapabilityRows } from '../src/vox/tools.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('VoxVision\'s tools in the Control Room', () => {
  it('a group of their own between Vision and Models; /room\'s needs-setup line counts them with the other rows, as before', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-vox-'));
    dirs.push(root);
    const vox = voxCapabilityRows({ env: {}, onPath: () => null, root }) as CapabilityRow[];
    expect(vox.length).toBeGreaterThan(5);
    const FAKE: CapabilityRow[] = [
      { id: 'blender', kind: 'adapter', name: 'Blender (Python, headless)', rung: 'needs setup', detail: 'FAKE: not found', setup: 'brew install --cask blender (FAKE)' },
      { id: 'look', kind: 'tool', name: 'Image observations (/observe)', rung: 'installed', detail: 'FAKE' },
      { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'installed', detail: 'FAKE: key set; not contacted' },
      { id: 'trigger', kind: 'tool', name: 'Trigger.dev jobs', rung: 'needs setup', detail: 'FAKE: no key', setup: 'set TRIGGER_SECRET_KEY' },
    ];
    const rows = [...FAKE, ...vox];
    const groups = toolGroups(rows);
    expect(groups.map((g) => g.title)).toEqual(['Creative apps', 'Vision', 'VoxVision', 'Models', 'Everything else /tools checks']);
    const group = groups.find((g) => g.title === 'VoxVision')!;
    expect(group.rows.map((r) => r.id)).toEqual(vox.map((r) => r.id));
    expect(group).toMatchObject({ apart: true, note: expect.stringContaining('/inspect, /measure, /detect, /compare and /vox view') });
    expect(groups.at(-1)!.rows.map((r) => r.id)).toEqual(['trigger']);
    // /room's text: the named groups' needs-setup rows, as before; VoxVision's are counted with the other rows.
    const voxSetup = vox.filter((r) => r.rung === 'needs setup').length;
    expect(voxSetup).toBeGreaterThan(0);
    expect(needsSetup(rows).map((r) => r.id)).toEqual(['blender']);
    expect(setupCounts(rows)).toEqual({ named: 3, otherNeedSetup: 1 + voxSetup });
    // The board's panel: VoxVision is a card of the panel, not folded under "everything else".
    const html = toolsPanel({ tools: { checkedAt: '2026-10-10T09:00:00.000Z', rows } } as unknown as RoomView, kit({ live: false, base: '../../' }));
    const folded = html.indexOf('<details class="more" data-keep="room:tools:other">');
    const card = html.indexOf(`<h4>VoxVision <span class="count">${vox.length}</span></h4>`);
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(folded);
    expect(html.slice(folded)).not.toContain('vox:');
    expect(html.slice(folded)).toContain('Trigger.dev jobs');
    expect(html).toContain('Timmy&#39;s STL reader');
  });
});
