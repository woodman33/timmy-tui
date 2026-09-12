import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProofLadder, HOUDINI_PROOF_FRAMES, validateProofManifest, type ProofLadderManifest } from '../src/vision/proof-ladder.js';
import { saveVisionEvent, storeVisionImage, visionHash, imageHash } from '../src/vision/store.js';
import { verifyChain } from '../src/utils/receipts.js';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=', 'base64');
let dir: string; let manifest: ProofLadderManifest;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-proof-ladder-'));
  manifest = { schema: 'timmy-houdini-proof-inputs/1', project: 'anomaly-example', sceneSHA256: 'a'.repeat(64), fps: 24,
    workflow: { specificationSHA256: 'b'.repeat(64) }, checks: [
      { id:'anomaly', label:'Clear anomaly shell', output:'predictions', className:'anomaly' },
      { id:'core', label:'Central core', output:'predictions', className:'core' },
    ], frames: HOUDINI_PROOF_FRAMES.map(frame => { const imagePath=join(dir, `frame-${frame}.png`); writeFileSync(imagePath,PNG); return {frame,imagePath,imageSHA256:imageHash(PNG),imageSrc:`/proofs/frame-${frame}.png`}; }) };
});
afterEach(() => rmSync(dir, { recursive:true, force:true }));
function observe(frame=1, result: unknown=[{predictions:{predictions:[{class:'anomaly',confidence:.81,x:500,y:320,width:120,height:170}]}}], overrides: Record<string,unknown>={}) {
  const image=storeVisionImage(PNG,'image/png',`frame-${frame}.png`,{dir});
  return saveVisionEvent({state:'observed',image,provenance:{runtime:'http',specificationHash:manifest.workflow.specificationSHA256,workflowDefinitionCaptured:true,parametersHash:visionHash({})},
    metadata:{houdini:{project:manifest.project,sceneSHA256:manifest.sceneSHA256,frame}},result,resultHash:visionHash(result),confidence:{count:1,min:.81,max:.81},needsReview:true,...overrides},{dir});
}
describe('native frame / Timmy Vision proof bridge', () => {
  it('keeps all five frames pending and creates no receipts when there are no matching real inspections', () => {
    expect(buildProofLadder(manifest,{dir}).frames.map(frame=>frame.state)).toEqual(Array(5).fill('pending_inspection'));
    expect(buildProofLadder(manifest,{dir}).frames.map(frame=>frame.frame)).toEqual([1,61,121,181,240]);
  });
  it('joins only exact scene, frame, input and Workflow hashes, with signed receipt verification', () => {
    const event=observe(); const report=buildProofLadder(manifest,{dir});
    expect(report.frames[0]).toMatchObject({state:'observed',receiptHash:event.receiptHash,resultHash:event.resultHash});
    expect(report.frames[1].state).toBe('pending_inspection');
    expect(report.frames[0].observations[0]).toMatchObject({state:'detected',count:1,minConfidence:.81});
    expect(report.frames[0].observations[1]).toMatchObject({state:'not_detected',count:0,minConfidence:null});
    expect(report.frames[0].observations[1].note).toContain('does not prove');
    expect(verifyChain('runs',dir).ok).toBe(true);
  });
  it('does not repurpose unrelated observations or trust a tampered signed record', () => {
    observe(1,[],{metadata:{houdini:{project:'unrelated',sceneSHA256:manifest.sceneSHA256,frame:1}}});
    expect(buildProofLadder(manifest,{dir}).frames[0].state).toBe('pending_inspection');
    observe();
    const journal=join(dir,'.timmy/vision/events.jsonl');
    const rows=readFileSync(journal,'utf8').trim().split('\n').map(row=>JSON.parse(row));
    rows[1].result=[{predictions:{predictions:[]}}];rows[1].resultHash=visionHash(rows[1].result);
    writeFileSync(journal,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    expect(buildProofLadder(manifest,{dir}).frames[0].state).toBe('integrity_error');
  });
  it('does not infer visibility from missing output or unsupported prediction shapes', () => {
    observe(1,[{unrelated:19}]); expect(buildProofLadder(manifest,{dir}).frames[0].observations[0]).toMatchObject({state:'not_reported',count:null});
    observe(61,[{predictions:[1,2,3]}]); expect(buildProofLadder(manifest,{dir}).frames[1].observations[0]).toMatchObject({state:'not_reported',count:null});
  });
  it('flags changed frame pixels and failed inference without inventing observations', () => {
    observe(1,{error:'failed'},{state:'failed'});
    expect(buildProofLadder(manifest,{dir}).frames[0]).toMatchObject({state:'failed',observations:[]});
    writeFileSync(manifest.frames[1].imagePath,Buffer.from('changed'));
    expect(buildProofLadder(manifest,{dir}).frames[1].state).toBe('integrity_error');
  });
  it('requires the user-selected five native frame numbers and a pinned Workflow identity', () => {
    expect(()=>validateProofManifest({...manifest,frames:manifest.frames.slice(0,2)})).toThrow('1, 61, 121, 181 and 240');
    expect(()=>validateProofManifest({...manifest,workflow:{}})).toThrow('Pin a Workflow');
  });
});
