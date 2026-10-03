"""Development checks only. This subset cannot qualify the frozen F1 matrix."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
fixtures = root / 'proto/fixtures'
manifest = json.loads((fixtures / 'development-cases.json').read_text())
cue = os.environ.get('F1_CUE', 'cue')
results = []
for name in ['positive-sigma-absent', 'positive-sigma-present', *manifest['negatives']]:
    positive = name.startswith('positive-')
    case = {} if positive else manifest['negatives'][name]
    argv = [cue, 'vet', str(root / 'proto/gen/cue/space_proto_gen.cue'),
            str(root / 'proto/gen/cue/semantics.cue'), str(fixtures / (name + '.json')), '-c']
    run = subprocess.run(argv, capture_output=True)
    diagnostic = (run.stdout + run.stderr).decode()
    expected = 0 if positive else case['expected_exit']
    passed = run.returncode == expected and (positive or case['diagnostic'] in diagnostic)
    results.append(dict(case=name, expected_exit=expected, actual_exit=run.returncode,
                        diagnostic=diagnostic, passed=passed,
                        stdout_sha256=hashlib.sha256(run.stdout).hexdigest(),
                        stderr_sha256=hashlib.sha256(run.stderr).hexdigest()))
print(json.dumps(dict(qualification=False, results=results,
                     missing_controls=manifest['missing_controls']), indent=2))
sys.exit(0 if all(r['passed'] for r in results) else 1)
