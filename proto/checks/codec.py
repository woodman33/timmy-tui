"""Run with generated Python bindings on PYTHONPATH, in an isolated runtime."""
import base64
import json
from pathlib import Path
import sys
from google.protobuf import json_format
from timmy.space.v1.space_pb2 import ContractFixture
value = json.loads(Path(sys.argv[1]).read_text())['input']
before = json_format.ParseDict(value, ContractFixture())
after = ContractFixture.FromString(before.SerializeToString())
assert after == before
assert after.leaf.HasField('sigma') == ('sigma' in value['leaf'])
assert after.receipt.canonical_json == base64.b64decode(value['receipt']['canonicalJson'])
assert after.leaf.origin.x == -8
assert len(after.jobs) == 6
print(json.dumps(dict(qualification=False, language='python', sigmaPresent=after.leaf.HasField('sigma'), receiptBytesPreserved=True, states=[j.state for j in after.jobs])))
