import { describe, it, expect } from 'vitest';
import { compileMissionMap, type MissionMapDoc } from '../src/utils/slate-compiler.js';
import { edlToOtio, sanitizeMediaUrl } from '../src/utils/otio.js';
import { theatreStateFromSequence, theatreSequenceToTransforms, type TheatreSequence } from '../src/utils/motion.js';
import type { Edl } from '../src/utils/edl.js';

describe('Mission Map → DispatchPlan compiler', () => {
  const doc = (over: Partial<MissionMapDoc> = {}): MissionMapDoc => ({
    nodes: [
      { id: 'capA', kind: 'capsule', objective: 'render the sting', copies: 1 },
      { id: 'hA', kind: 'harness', harness: 'hyperframes' },
      { id: 'capB', kind: 'capsule', objective: 'sandbox fix', max_spend: 0 },
      { id: 'hB', kind: 'harness', harness: 'openhands', workspace: 'docker' },
      { id: 'gateB', kind: 'gate', approval: 'manual', acceptance: ['npm test'] },
      { id: 'artA', kind: 'artifact', path: 'package.json' },
      ...over.nodes ?? []
    ],
    edges: [
      { from: 'hA', to: 'capA', kind: 'harness' },
      { from: 'hB', to: 'capB', kind: 'harness' },
      { from: 'gateB', to: 'capB', kind: 'gate' },
      { from: 'artA', to: 'capB', kind: 'artifact' },
      { from: 'capA', to: 'capB', kind: 'depends' },
      ...over.edges ?? []
    ],
    ...over
  });

  it('compiles capsules in dependency order with manifests, gates and workspace requests', () => {
    const r = compileMissionMap(doc());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.plans.map(p => p.node_id)).toEqual(['capA', 'capB']);
    const [a, b] = r.plans;
    expect(a.plan.harnesses).toEqual(['hyperframes']);
    expect(a.plan.cadence.depends_on).toEqual([]);
    expect(b.plan.cadence.depends_on).toEqual(['capA']);
    expect(b.plan.cadence.mode).toBe('sequential');
    expect(b.plan.acceptance_tests).toContain('npm test');
    expect(b.plan.approval.mode).toBe('manual');
    expect(b.plan.workspace.kind).toBe('docker');
    expect(b.plan.context_manifest).toHaveLength(1);
    expect(b.plan.context_manifest[0].path).toBe('package.json');
    expect(b.plan.context_manifest[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown harnesses, missing artifacts and cycles', () => {
    const badHarness = compileMissionMap({
      nodes: [
        { id: 'capA', kind: 'capsule', objective: 'x' },
        { id: 'hX', kind: 'harness', harness: 'not-a-lane' }
      ],
      edges: [{ from: 'hX', to: 'capA', kind: 'harness' }]
    });
    expect(badHarness.ok).toBe(false);
    expect(badHarness.errors.join(' ')).toContain("unknown harness 'not-a-lane'");

    const missingArt = compileMissionMap({
      nodes: [
        { id: 'capA', kind: 'capsule', objective: 'x' },
        { id: 'hA', kind: 'harness', harness: 'hyperframes' },
        { id: 'artX', kind: 'artifact', path: 'no-such-file.bin' }
      ],
      edges: [
        { from: 'hA', to: 'capA', kind: 'harness' },
        { from: 'artX', to: 'capA', kind: 'artifact' }
      ]
    });
    expect(missingArt.ok).toBe(false);
    expect(missingArt.errors.join(' ')).toContain('artifact missing');

    const cycle = compileMissionMap({
      nodes: [
        { id: 'capA', kind: 'capsule', objective: 'a' },
        { id: 'hA', kind: 'harness', harness: 'hyperframes' },
        { id: 'capB', kind: 'capsule', objective: 'b' },
        { id: 'hB', kind: 'harness', harness: 'openhands' }
      ],
      edges: [
        { from: 'hA', to: 'capA', kind: 'harness' },
        { from: 'hB', to: 'capB', kind: 'harness' },
        { from: 'capA', to: 'capB', kind: 'depends' },
        { from: 'capB', to: 'capA', kind: 'depends' }
      ]
    });
    expect(cycle.ok).toBe(false);
    expect(cycle.errors.join(' ')).toContain('cycle');
  });

  it('requires exactly one harness slide per capsule', () => {
    const r = compileMissionMap(doc({ edges: [] }));
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
  });
});

describe('OTIO multi-track + timebase + sanitization', () => {
  const edl: Edl = {
    edl_version: 1,
    output: 'out.mp4',
    timebase: 30,
    clips: [{ src: '<home>/media/a.mp4#t=1,3' }],
    audio_stems: [
      { src: 'studio/score.flac#t=0,5', kind: 'music', duck_db: -12 },
      { src: 'studio/vo.flac#t=0,4', kind: 'vo' }
    ]
  };

  it('propagates the explicit timebase to every RationalTime', () => {
    const o = edlToOtio(edl) as any;
    expect(o.global_start_time.rate).toBe(30);
    expect(o.tracks.children[0].children[0].source_range.start_time.rate).toBe(30);
    expect(o.tracks.children[0].children[0].source_range.duration.value).toBe(60); // 2s @ 30
  });

  it('emits one Audio track per stem kind after the video track', () => {
    const o = edlToOtio(edl) as any;
    const kinds = o.tracks.children.map((t: any) => t.kind);
    expect(kinds).toEqual(['Video', 'Audio', 'Audio']);
    const music = o.tracks.children[1];
    expect(music.name).toBe('timmy music');
    expect(music.children[0].metadata.timmy.duck_db).toBe(-12);
  });

  it('sanitizes absolute/home paths to bundle-relative media urls, keeping fragments', () => {
    const o = edlToOtio(edl, {}, { sanitize: true }) as any;
    // OTIO refs carry the path; timing lives in source_range (fragment stripped)
    expect(o.tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url)
      .toBe('media/a.mp4');
    const raw = edlToOtio(edl) as any;
    expect(raw.tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url)
      .toBe('<home>/media/a.mp4');
    expect(sanitizeMediaUrl('~/x/vo.flac#t=0,4')).toBe('media/vo.flac#t=0,4');
    expect(sanitizeMediaUrl('studio/rel.mp4')).toBe('studio/rel.mp4');
  });
});

describe('Theatre.js native sheets with Bézier states', () => {
  const seq: TheatreSequence = {
    name: 'sting',
    duration: 5,
    tracks: [
      {
        target: 'clip-0', prop: 'position.x',
        keyframes: [
          { t: 0, value: 0 },
          { t: 1.5, value: 120, handles: [0.16, 1, 0.3, 1] }
        ]
      }
    ]
  };

  it('emits native on-disk state (definition 0.4.0, sheets keyed by id)', () => {
    const s = theatreStateFromSequence(seq);
    expect(s.definitionVersion).toBe('0.4.0');
    expect(s.revision).toBe(0);
    const sheet = s.sheets['sting'];
    expect(sheet).toBeTruthy();
    expect(sheet.sequence.type).toBe('Theatre_Sequence');
    expect(sheet.sequence.length).toBe(5);
    const track = sheet.sequence.tracks['clip-0.position.x'];
    expect(track.type).toBe('Theatre_Track');
    expect(track.keyframes).toHaveLength(2);
  });

  it('keyframes carry cubic-bézier interpolation (default + custom handles)', () => {
    const track = theatreStateFromSequence(seq).sheets['sting'].sequence.tracks['clip-0.position.x'];
    expect(track.keyframes[0].interpolation).toEqual({ type: 'CubicBezier', config: { handles: [0.42, 0, 0.58, 1] } });
    expect(track.keyframes[1].interpolation.config.handles).toEqual([0.16, 1, 0.3, 1]);
    expect(track.keyframes[1].position).toBe(1.5);
  });

  it('EDL transform compile still works (compile-to-EDL law)', () => {
    const t = theatreSequenceToTransforms(seq);
    expect(t).toEqual([
      { target: 'clip-0', at: 0, prop: 'position.x', value: 0 },
      { target: 'clip-0', at: 1.5, prop: 'position.x', value: 120 }
    ]);
  });
});
