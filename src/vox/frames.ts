/**
 * Timmy VoxVision (round R4, helper H61): the coordinate frame each input's values are in, said in words, and whether
 * two inputs share one. A frame names its space and its unit, and how that unit is known:
 *
 *   STL     the file's own model frame, in the file's units: not declared (an STL carries no unit)
 *   STEP    the file's own model frame, in millimetres: OCP converts the file's declared length unit to millimetres and
 *           reports the unit in effect (when it does not, millimetres are assumed, and said)
 *   .blend  the scene's world frame, in Blender units (the scene's unit settings are reported, never applied)
 *   PLY     the file's own coordinates, in the file's units: not declared (a PLY carries no unit)
 *   image   its pixel frame: width × height px, x to the right and y down from its top-left corner
 *   video   its pixel frame, one frame per time
 *
 * A drawing of two inputs together (two bounding boxes at one scale, a 3D overlay in a viewer) is made only when both
 * are in the same kind of frame with one known unit (for pixels, also the same size). Otherwise the record says why
 * there is none, and numbers compared across the two are "estimated", never given a unit neither file declares.
 */
import type { VoxKind } from './kinds.js';

export type FrameSpace = 'model' | 'scene' | 'points' | 'pixels' | 'video pixels' | 'none';
/** declared by the file; reported by the reader that read it; assumed (said); not declared at all; not read (no tool ran) */
export type UnitBy = 'declared' | 'reported' | 'assumed' | 'not declared' | 'not read';

export interface VoxFrame {
  space: FrameSpace;
  /** the unit its lengths are in (mm, px, Blender units); null when none is known */
  unit: string | null;
  unit_by: UnitBy;
  /** pixels: width and height */
  size?: [number, number];
  /** the frame in a person's words */
  words: string;
}

const dims = (s: [number, number]): string => `${s[0]} × ${s[1]} px`;
const isSize = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isInteger(x) && x > 0);

export const stlFrame = (): VoxFrame => ({ space: 'model', unit: null, unit_by: 'not declared', words: "the STL's own model frame, in the file's units: not declared (an STL carries no unit)" });
export const plyFrame = (): VoxFrame => ({ space: 'points', unit: null, unit_by: 'not declared', words: "the PLY's own coordinates, in the file's units: not declared (a PLY carries no unit)" });

/** A STEP's frame: as OCP reported the unit in effect (MM), assumed millimetres when it did not say, unread when OCP did not run. */
export function stepFrame(read: { unit_in_effect?: string | null } | null): VoxFrame {
  if (!read) return { space: 'model', unit: null, unit_by: 'not read', words: "the STEP's own model frame; its length unit was not read (OCP did not read the file here)" };
  if (typeof read.unit_in_effect === 'string' && read.unit_in_effect.toUpperCase() === 'MM') {
    return { space: 'model', unit: 'mm', unit_by: 'reported', words: "the STEP's own model frame, in millimetres: OCP converted the file's declared length unit and reported MM in effect" };
  }
  const said = typeof read.unit_in_effect === 'string' && read.unit_in_effect ? `OCP reported ${read.unit_in_effect} in effect, and the worker says mm` : 'OCP did not report the unit in effect';
  return { space: 'model', unit: 'mm', unit_by: 'assumed', words: `the STEP's own model frame, in millimetres assumed: ${said}` };
}

/** A .blend's frame: Blender units, with the scene's unit settings as reported. */
export function blendFrame(units: unknown): VoxFrame {
  const u = units && typeof units === 'object' ? units as { system?: unknown; scale_length?: unknown; length_unit?: unknown } : undefined;
  if (!u) return { space: 'scene', unit: 'Blender units', unit_by: 'not read', words: "the scene's world frame, in Blender units (its unit settings were not read)" };
  const parts = [typeof u.system === 'string' ? u.system : '', typeof u.scale_length === 'number' ? `scale ${u.scale_length}` : '', typeof u.length_unit === 'string' ? u.length_unit : ''].filter(Boolean).join(', ');
  return { space: 'scene', unit: 'Blender units', unit_by: 'declared', words: `the scene's world frame, in Blender units (its unit settings say ${parts || 'nothing'}: reported, never applied)` };
}

export function imageFrame(size?: [number, number] | null): VoxFrame {
  return isSize(size)
    ? { space: 'pixels', unit: 'px', unit_by: 'reported', size: [size[0], size[1]], words: `the image's pixel frame: ${dims(size)}, x to the right and y down from its top-left corner` }
    : { space: 'pixels', unit: 'px', unit_by: 'not read', words: "the image's pixel frame (its size was not read: Look did not run)" };
}

export function videoFrame(size?: [number, number] | null): VoxFrame {
  return isSize(size)
    ? { space: 'video pixels', unit: 'px', unit_by: 'declared', size: [size[0], size[1]], words: `the video's pixel frame: ${dims(size)}, x to the right and y down from the top-left corner, one frame per time` }
    : { space: 'video pixels', unit: 'px', unit_by: 'not read', words: "the video's pixel frame (its size was not read: the video readback did not run)" };
}

export const noFrame = (): VoxFrame => ({ space: 'none', unit: null, unit_by: 'not declared', words: 'no spatial frame: VoxVision does not read this kind' });

/** A kind's frame before any tool reads it (what /compare can say before it runs). */
export function kindFrame(kind: VoxKind): VoxFrame {
  switch (kind) {
    case 'stl': return stlFrame();
    case 'ply': return plyFrame();
    case 'step': return { space: 'model', unit: 'mm', unit_by: 'reported', words: "a STEP's own model frame, in millimetres as OCP reports them" };
    case 'blend': return blendFrame(undefined);
    case 'image': return imageFrame();
    case 'video': return videoFrame();
    default: return noFrame();
  }
}

/** A kind as a sentence names it. */
export const KIND_A: Readonly<Record<VoxKind, string>> = {
  image: 'an image', stl: 'an STL', step: 'a STEP', blend: 'a .blend', video: 'a video', ply: 'a PLY', other: 'a file VoxVision does not read',
};

/**
 * Whether two inputs share a known frame and unit, so the two may be drawn together (two bounding boxes at one scale,
 * a pixel heatmap, a 3D overlay): the words say why or why not.
 */
export function together(a: { kind: VoxKind; frame: VoxFrame }, b: { kind: VoxKind; frame: VoxFrame }): { drawn: boolean; words: string } {
  const A = KIND_A[a.kind];
  const B = KIND_A[b.kind];
  const pair = a.kind === b.kind ? `the two ${a.kind === 'stl' ? 'STLs' : a.kind === 'ply' ? 'PLYs' : a.kind === 'step' ? 'STEPs' : a.kind === 'video' ? 'videos' : a.kind === 'image' ? 'images' : 'files'}` : `${A} and ${B}`;
  if (a.frame.space === 'none' || b.frame.space === 'none') return { drawn: false, words: `${pair} are not both files VoxVision reads in a frame: nothing of the two is drawn together` };
  if (a.frame.space !== b.frame.space) {
    return { drawn: false, words: `${pair} are in different kinds of frame (${a.frame.words}; ${b.frame.words}): no overlay or geometric compare is drawn` };
  }
  const unitless = [a, b].filter((x) => x.frame.unit === null);
  if (unitless.length) {
    const who = unitless.length === 2 ? `neither ${a.kind === b.kind ? `${a.kind === 'stl' ? 'STL' : a.kind === 'ply' ? 'PLY' : 'file'}` : 'file'} declares a unit` : `${KIND_A[unitless[0].kind]} declares no unit`;
    return { drawn: false, words: `no drawing of both: ${who}, so ${pair} share no known unit; their numbers are compared in the files' own units and marked estimated, never given millimetres` };
  }
  const assumed = [a, b].filter((x) => x.frame.unit_by === 'assumed' || x.frame.unit_by === 'not read');
  if (assumed.length) return { drawn: false, words: `no drawing of both: ${assumed.map((x) => x.frame.words).join('; ')}` };
  if (a.frame.unit !== b.frame.unit) return { drawn: false, words: `no drawing of both: ${pair} are in different units (${a.frame.unit} and ${b.frame.unit})` };
  if (a.frame.space === 'pixels' || a.frame.space === 'video pixels') {
    if (!a.frame.size || !b.frame.size) return { drawn: false, words: `no drawing of both: the size of ${pair}'s pixel frames was not read` };
    if (a.frame.size[0] !== b.frame.size[0] || a.frame.size[1] !== b.frame.size[1]) return { drawn: false, words: `no drawing of both: ${pair} are different pixel frames (${dims(a.frame.size)} and ${dims(b.frame.size)})` };
    if (a.frame.space === 'video pixels') return { drawn: true, words: `${pair} share one ${dims(a.frame.size)} pixel frame: centroids sampled at the same times can be compared in it` };
    return { drawn: true, words: `${pair} share one ${dims(a.frame.size)} pixel frame: they are compared pixel by pixel` };
  }
  if (a.frame.space === 'scene') return { drawn: false, words: `${pair} are each in their own scene: two .blend files are not drawn together` };
  return { drawn: true, words: `${pair} are both in ${a.frame.unit === 'mm' ? 'millimetres' : a.frame.unit}, each in its own model frame: their boxes are drawn at one scale, each from its own minimum corner (sizes compared, not positions)` };
}

/** Why /compare refuses two files of different kinds, said by their frames (before any tool reads them). */
export function apart(a: VoxKind, b: VoxKind): string {
  const t = together({ kind: a, frame: kindFrame(a) }, { kind: b, frame: kindFrame(b) });
  if (t.drawn) return '';
  if ((a === 'video' && b === 'image') || (a === 'image' && b === 'video')) {
    return "A video's pixel frame changes with time and an image has one frame: they share no frame, so no overlay or geometric compare is drawn; /detect each.";
  }
  const one = (k: VoxKind): string => (k === 'stl' ? 'an STL declares no unit' : k === 'ply' ? 'a PLY declares no unit' : k === 'step' ? 'a STEP is in millimetres as OCP reports them' : k === 'blend' ? 'a .blend is in Blender units' : k === 'image' ? 'an image is in pixels' : k === 'video' ? 'a video is in pixels, one frame per time' : 'VoxVision reads no frame for it');
  return `They share no known frame and unit either: ${one(a)} and ${one(b)}, so no overlay or geometric compare is drawn; /measure each.`;
}

/** An input's frame as a record from before H61 lets it be told (its kind, and the values its tool recorded for it). */
export function frameFromRecord(input: { kind?: string; role?: string; frame?: unknown }, metrics: ReadonlyArray<{ name: string; value: unknown; unit?: string; of?: string }>): VoxFrame {
  const f = input.frame && typeof input.frame === 'object' ? input.frame as Partial<VoxFrame> : undefined;
  if (f && typeof f.words === 'string' && typeof f.space === 'string') return f as VoxFrame;
  const mine = metrics.filter((m) => (input.role ? m.of === input.role : !m.of || m.of !== 'delta'));
  const val = (n: string): unknown => mine.find((m) => m.name === n)?.value;
  switch (input.kind) {
    case 'stl': return stlFrame();
    case 'ply': return plyFrame();
    case 'step': {
      const box = mine.find((m) => m.name === 'bbox_size');
      if (!box) return stepFrame(null);
      return stepFrame({ unit_in_effect: typeof box.unit === 'string' && box.unit.includes('not reported') ? null : 'MM' });
    }
    case 'blend': return blendFrame(val('units'));
    case 'image': { const w = val('width'); const h = val('height'); return imageFrame(typeof w === 'number' && typeof h === 'number' ? [w, h] : null); }
    case 'video': { const w = val('width'); const h = val('height'); return videoFrame(typeof w === 'number' && typeof h === 'number' ? [w, h] : null); }
    default: return noFrame();
  }
}
