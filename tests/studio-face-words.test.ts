import { describe, expect, it } from 'vitest';
import { eventFace, faceTitle, faceWords, fileName } from '../companion/studio-canvas/src/face.js';

// R10 (H167, Step C; the round's rule: "technical diagnostics (hashes, bus details, raw commands, ports, paths, ids) in a
// secondary inspector or details control"): what Studio's face says of a record. Its words lose an id, a hash and a place; a
// receipt, a job, a flow and an operation are named by kind, a file by its name; the words a count or a name says are kept.
describe("Studio's face words (companion/studio-canvas/src/face.js)", () => {
  it('names a receipt, a job, a flow and an operation by kind, and drops a part in brackets that names an id', () => {
    expect(faceWords("answered · the Workbench's chat turn answered (receipt 7c3cc280)")).toBe("answered · the Workbench's chat turn answered");
    expect(faceWords('receipt 1a2b3c4d does not verify now: its signature does not verify')).toBe('its receipt does not verify now: its signature does not verify');
    expect(faceWords('proposed by job turn-0c575980 from flow f1a2b3c4d')).toBe('proposed by the job from the flow');
    expect(faceWords('ran as operation o672293f5 (2 steps)')).toBe('ran as the operation (2 steps)');
    expect(faceWords('sealed exactly these bytes (sha256 9f86d081884c)')).toBe('sealed exactly these bytes');
  });

  it("says a file by its name and leaves a folder, or a place named by an id, out", () => {
    expect(faceWords('detect refs/preview.png')).toBe('detect preview.png');
    expect(faceWords('Tray recipe parameters (recipes/tray.params.json)')).toBe('Tray recipe parameters (tray.params.json)');
    expect(faceWords('saved in ~/timmy/canvas/projects/20b834eaf2966f6b')).toBe('saved in');
    expect(faceWords('kept in .timmy/flows/')).toBe('kept in');
    expect(fileName('results/vox/v1/annotated.png')).toBe('annotated.png');
    expect(fileName('APPROVAL.md')).toBe('APPROVAL.md');
  });

  it('keeps words that name no id: a count, a version, a size, a name with a dot', () => {
    for (const w of ['5 receipts, 12345679 bytes', 'tldraw 5.5.2 · unlicensed, fine locally', 'width 140, wall 3, bore 3 (mm)', 'not run yet · 1 block: tidy', 'Build <img src=x onerror="window.__xss=1"> & "quoted"']) {
      expect(faceWords(w)).toBe(w);
    }
  });

  it("a record's title without its operation's id before its request; an event's words as the companion's stream says them", () => {
    expect(faceTitle('operation o672293f5: Summarise the newest run in one line.')).toBe('Summarise the newest run in one line.');
    expect(faceTitle('Approval: see a NEEDS YOU box')).toBe('Approval: see a NEEDS YOU box');
    // a flow's and a run's card (src/studio/project-cards.ts): the command it starts with said as its word, its id left out
    expect(faceTitle('/iterate tray · f1a2b3c4d: make the walls thicker')).toBe('iterate tray: make the walls thicker');
    expect(faceTitle("the REPL · o1a2b3c4d")).toBe('the REPL');
    expect(faceTitle('Unreadable record results/flows/f0badbad0.json')).toBe('Unreadable record');
    expect(faceWords('Flow f1a2b3c4d ran; Receipt 1a2b3c4d sealed it')).toBe('The flow ran; Its receipt sealed it');
    expect(eventFace('turn answered in the Workbench · fake-qwen3:8b · receipt 7c3cc280 · 0.5 s')).toBe('turn answered in the Workbench · fake-qwen3:8b · receipt sealed · 0.5 s');
    expect(eventFace('j1a2b3c: completed (o672293f5)')).toBe('completed');
  });
});
