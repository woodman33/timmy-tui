// Run inside a prospectively bound isolated runtime with these exact source bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fromJson, fromBinary, toBinary, toJson} from '@bufbuild/protobuf';
import {ContractFixtureSchema} from './space_pb.js';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8')).input;
const before = fromJson(ContractFixtureSchema, input);
const after = fromBinary(ContractFixtureSchema, toBinary(ContractFixtureSchema, before));
assert.deepEqual(toJson(ContractFixtureSchema, after), toJson(ContractFixtureSchema, before));
assert.equal(after.leaf?.sigma !== undefined, Object.hasOwn(input.leaf, 'sigma'));
assert.deepEqual(Buffer.from(after.receipt!.canonicalJson), Buffer.from(input.receipt.canonicalJson, 'base64'));
assert.equal(after.leaf?.origin?.x, -8);
assert.equal(after.jobs.length, 6);
console.log(JSON.stringify({qualification:false, language:'typescript', sigmaPresent:after.leaf?.sigma!==undefined, receiptBytesPreserved:true, states:after.jobs.map(j=>j.state)}));
