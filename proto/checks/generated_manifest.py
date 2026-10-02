"""Compare generated files to independently retained committed digests."""
import hashlib
import json
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / 'proto/generated-manifest.json').read_text())
expected = manifest['files']
actual = {str(p.relative_to(root)) for lang in ['ts','rust','go','python']
          for p in (root / 'proto/gen' / lang).rglob('*') if p.is_file()}
errors = []
if actual != set(expected):
    errors.append(dict(missing=sorted(set(expected)-actual), unexpected=sorted(actual-set(expected))))
for name in sorted(actual & set(expected)):
    data = (root / name).read_bytes()
    if len(data) != expected[name]['size'] or hashlib.sha256(data).hexdigest() != expected[name]['sha256']:
        errors.append(dict(changed=name))
print(json.dumps(dict(qualification=False, languages=4, files=len(actual), errors=errors), indent=2))
sys.exit(bool(errors))
