/**
 * The OpenHands worker's own event lines, run for real under this machine's python3 (round R4, the Mac's first real run of
 * /agent openhands, ledger row 159). Its emit() took the line's type as a parameter named `kind`, and the action,
 * observation and event lines also pass a field named `kind` (the SDK's own), so the first ActionEvent raised
 * "TypeError: emit() got multiple values for argument 'kind'" and ended every run at its first tool call. The SDK is not
 * installed here: the worker is imported as a module (it imports the SDK only inside its functions) and its Events
 * handler is given FAKE events, named as the SDK names its event classes, with a model_dump() as pydantic models have.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WORKER = join(__dirname, '..', 'workers', 'openhands', 'timmy_openhands.py');
const PY = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("timmy_openhands", sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class Dump:
    def __init__(self, data): self._d = data
    def model_dump(self, mode=None): return self._d

def fake(name, data):
    return type(name, (Dump,), {})(data)

ev = w.Events(40)
ev(fake("ActionEvent", {"id": "e1", "tool_name": "terminal", "action": {"kind": "TerminalAction", "command": "ls"}, "thought": "look"}))
ev(fake("ObservationEvent", {"id": "e2", "tool_name": "terminal", "observation": {"kind": "TerminalObservation", "exit_code": 0, "content": "index.html"}}))
ev(fake("PauseEvent", {"id": "e3"}))
# An action the summary cannot read (its action is not a mapping): the handler's own fallback line, which also passes kind.
ev(fake("ActionEvent", {"id": "e4", "action": "not a mapping"}))
w.emit("result", status="finished", finished=True, steps=ev.steps)
`;

describe('the OpenHands worker writes its event lines (python3, FAKE SDK events)', () => {
  it('writes action, observation, event, fallback and result lines, each with its type and the SDK kind beside it', () => {
    const r = spawnSync('python3', ['-I', '-B', '-c', PY, WORKER], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.type, l.kind ?? null])).toEqual([
      ['action', 'TerminalAction'],
      ['observation', 'TerminalObservation'],
      ['event', 'PauseEvent'],
      ['event', 'ActionEvent'],
      ['result', null],
    ]);
    expect(String(lines[3].note)).toMatch(/^not summarised: /);
    expect(lines[0]).toMatchObject({ v: 1, n: 1, tool: 'terminal', command: 'ls' });
    expect(lines[1]).toMatchObject({ exit_code: 0, error: false });
    expect(lines[4]).toMatchObject({ status: 'finished', finished: true, steps: 2 });
    expect(r.stderr).not.toContain('TypeError');
  });
});
