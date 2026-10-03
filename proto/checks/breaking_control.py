"""Exercise a detached public-field deletion against a candidate descriptor."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[2]
buf = os.environ.get('F1_BUF', 'buf')
with tempfile.TemporaryDirectory(prefix='timmy-f1-breaking-') as td:
    work = Path(td)
    shutil.copytree(root / 'proto/timmy', work / 'proto/timmy')
    shutil.copyfile(root / 'buf.yaml', work / 'buf.yaml')
    baseline = work / 'candidate.binpb'
    build = subprocess.run([buf, 'build', '-o', str(baseline)], cwd=root, capture_output=True)
    if build.returncode != 0:
        sys.stderr.buffer.write(build.stderr)
        sys.exit(1)
    schema = work / 'proto/timmy/space/v1/space.proto'
    before = schema.read_text()
    needle = '  string request_id = 6;\n'
    start = before.index('message Job {')
    end = before.index('\n}', start)
    job = before[start:end]
    if job.count(needle) != 1:
        raise RuntimeError('Detached mutation is not uniquely bound to Job.request_id')
    schema.write_text(before[:start] + job.replace(needle, '', 1) + before[end:])
    run = subprocess.run([buf, 'breaking', '--against', str(baseline)], cwd=work, capture_output=True)
    diagnostic = (run.stdout + run.stderr).decode()
    passed = run.returncode == 100 and 'request_id' in diagnostic and 'Job' in diagnostic
    print(json.dumps(dict(case='N11-public-field-deletion', expected_exit=100,
                          actual_exit=run.returncode, diagnostic=diagnostic,
                          passed=passed, qualification=False), indent=2))
    sys.exit(0 if passed else 1)
