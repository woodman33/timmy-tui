/**
 * Round R4 (helper H78): what kind of file a run made, for God's Eye View's artifacts: an editable native file (and the
 * application whose native format it is), a preview (an image, a render, a document to look at) or an exchange file (STEP,
 * STL and the like). Told by the file's name only: the name says the format a run wrote; it says nothing of whether the
 * file opens, and nothing here opens, reads or runs it. The command shown is Timmy's own for that kind (src/ops/card.ts
 * fileCommands): `/open` gives the file's link, VoxVision's `/inspect` and `/measure` read a geometry or image file.
 */
import { fileCommands } from '../ops/card.js';

export interface ArtifactKind { kind: 'editable' | 'preview' | 'export'; editor?: string }

/** Native files an application edits, by extension (lower case), and that application. */
const EDITABLE: ReadonlyArray<[RegExp, string]> = [
  [/\.blend$/i, 'Blender'],
  [/\.fcstd$/i, 'FreeCAD'],
  [/\.aep$/i, 'After Effects'],
  [/\.ai$/i, 'Illustrator'],
  [/\.c4d$/i, 'Cinema 4D'],
  [/\.(umap|uasset|uproject)$/i, 'Unreal Engine'],
  [/\.scad$/i, 'OpenSCAD (its source)'],
  [/\.hip(nc|lc)?$/i, 'Houdini'],
  [/\.params\.json$/i, 'your editor, or the board\'s parameter card'],
  [/\.(py|jsx)$/i, 'your editor (a script the app runs)'],
  [/\.md$/i, 'your editor (a workflow document)'],
];
const PREVIEW = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|pdf)$/i;
const EXPORT = /\.(step|stp|stl|obj|glb|gltf|ply|3mf|usdz?|fbx)$/i;
/** Records, logs and transcripts: what a run kept about itself, not what it made. */
const NOT_ARTIFACT = /(^|\/)(job|result|run|state|call|output)\.json$|\.(log|jsonl)$|(^|\/)results\/(flows|vox)\/[^/]+\.json$/i;

/** The kind of a file a run made, by its name; undefined for a record, a log or a name of no kind known here. */
export function artifactKind(rel: string): ArtifactKind | undefined {
  if (NOT_ARTIFACT.test(rel)) return undefined;
  for (const [re, editor] of EDITABLE) if (re.test(rel)) return { kind: 'editable', editor };
  if (PREVIEW.test(rel)) return { kind: 'preview', editor: /\.(mp4|mov|webm)$/i.test(rel) ? 'a video player' : /\.pdf$/i.test(rel) ? 'a PDF reader' : 'an image viewer' };
  if (EXPORT.test(rel)) return { kind: 'export', editor: /\.(step|stp)$/i.test(rel) ? 'a CAD application (FreeCAD reads STEP)' : 'a 3D application' };
  return undefined;
}

/** The typed command that acts on it first (its link, or VoxVision's reading for a geometry or image file). */
export function artifactCommand(rel: string, role: string): string {
  return fileCommands(rel, role)[0] ?? `/open ${/\s/.test(rel) ? `"${rel}"` : rel}`;
}

/** The order artifacts are listed in: editable first, then exports, then previews. */
export const ARTIFACT_ORDER: Readonly<Record<ArtifactKind['kind'], number>> = { editable: 0, export: 1, preview: 2 };
