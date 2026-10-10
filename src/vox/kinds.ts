/**
 * Timmy VoxVision (round R4, helper H49): which supported tool reads a file, decided by the file's own bytes first
 * (src/project/intake.ts kindOf), then by its name where the bytes say nothing (an STL has no magic number).
 *
 *   image   Look (workers/look/look.py, OpenCV)                    PNG, JPEG, GIF, WebP by their bytes
 *   stl     Timmy's own STL reader (src/native/stl-readback.ts)    by name (.stl); its bytes are checked when read
 *   step    the STEP readback (workers/readback/step_readback.py)  ISO-10303-21 by its bytes, else .step/.stp
 *   blend   the .blend readback (workers/readback/blend_readback.py, in Blender)   BLENDER by its bytes, else .blend
 *   video   the video readback (workers/readback/video_readback.py: ffprobe, ffmpeg)   MP4/MOV/WebM by their bytes
 *   ply     the spatial module (ASCII Gaussian-splat PLY) and the geo lane (lanes/geo/voxel_score.py)   "ply" by its bytes
 *   other   none: VoxVision says which kinds it reads
 *
 * A name that disagrees with the bytes is said (the bytes win), as /add says it.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import { kindOf, type IntakeKind } from '../project/intake.js';

export type VoxKind = 'image' | 'stl' | 'step' | 'blend' | 'video' | 'ply' | 'other';
export type VoxTool = 'look' | 'stl' | 'step' | 'blend' | 'video' | 'spatial' | 'geo' | 'roboflow' | 'intake';

export interface VoxKindAnswer {
  kind: VoxKind;
  /** how it was told: the file's first bytes, or its name */
  by: 'bytes' | 'name';
  /** the intake's broader kind (image, video, 3d, document, other) */
  intake: IntakeKind;
  /** the name and the bytes disagree, or the bytes say a 3D format VoxVision does not read */
  note?: string;
}

/** The kinds VoxVision reads, in the order the board lists them, with the words a person reads. */
export const VOX_KINDS: ReadonlyArray<Exclude<VoxKind, 'other'>> = ['image', 'stl', 'step', 'blend', 'video', 'ply'];
export const KIND_WORDS: Readonly<Record<VoxKind, string>> = {
  image: 'image', stl: 'STL mesh', step: 'STEP (CAD)', blend: 'Blender scene (.blend)', video: 'video', ply: 'PLY point cloud', other: 'not a kind VoxVision reads',
};

/** The tool that reads each kind for /inspect and /measure. */
export const TOOL_OF: Readonly<Record<VoxKind, VoxTool | null>> = {
  image: 'look', stl: 'stl', step: 'step', blend: 'blend', video: 'video', ply: 'spatial', other: null,
};

/** What a file's head bytes are, read without following anything but the path given (at most n bytes). */
export function headBytes(path: string, n = 64): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(n);
    return b.subarray(0, readSync(fd, b, 0, n, 0));
  } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) closeSync(fd); }
}

const startsWith = (head: Buffer, s: string): boolean => head.length >= s.length && head.subarray(0, s.length).toString('latin1') === s;

/** The VoxVision kind of a file from its name and first bytes. */
export function voxKindOf(name: string, head: Buffer): VoxKindAnswer {
  const k = kindOf(name, head);
  const ext = extname(name).toLowerCase();
  const say = (kind: VoxKind, by: 'bytes' | 'name', note?: string): VoxKindAnswer => ({ kind, by, intake: k.kind, ...(note ? { note } : {}) });
  if (k.kind === 'image') return say('image', k.by, k.note);
  if (k.kind === 'video') return say('video', k.by, k.note);
  if (k.kind === '3d' && k.by === 'bytes') {
    const named = ext ? `the name says ${ext.slice(1)}; ` : '';
    if (startsWith(head, 'ply\n') || startsWith(head, 'ply\r\n')) return say('ply', 'bytes', ext && ext !== '.ply' ? `${named}the bytes say PLY` : undefined);
    if (startsWith(head, 'BLENDER')) return say('blend', 'bytes', ext && ext !== '.blend' ? `${named}the bytes say a .blend` : undefined);
    if (startsWith(head, 'ISO-10303-21;')) return say('step', 'bytes', ext && ext !== '.step' && ext !== '.stp' ? `${named}the bytes say STEP` : undefined);
    return say('other', 'bytes', 'a 3D format VoxVision does not read (glTF, FBX or USD by its bytes)');
  }
  if (k.by === 'bytes') return say('other', 'bytes', k.note);
  // The bytes say nothing: the name decides (an STL has no magic number; a compressed .blend begins with gzip or zstd).
  if (ext === '.stl') return say('stl', 'name');
  if (ext === '.step' || ext === '.stp') return say('step', 'name');
  if (ext === '.blend') return say('blend', 'name');
  if (ext === '.ply') return say('ply', 'name');
  return say('other', 'name');
}
