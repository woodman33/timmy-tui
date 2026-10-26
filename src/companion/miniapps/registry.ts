/**
 * R13 (the 2026-10-26 integration order): the mini-apps Timmy hosts, and what is known about each one's source.
 *
 * Timmy does not rewrite these apps. Each one is its owner's standalone program; Timmy starts it as a supervised worker
 * behind its own server (./host.ts), with the request's verified principal and project choosing its data folder, and the
 * spending hold kept (no paid-call switch and no provider key is passed to it). An app whose reviewed source is not in hand
 * is listed with the facts that were observed and the step that is missing, never shown as if it ran.
 *
 * `sourceEnv` names the variable that points at the app's folder on this computer (a review package sets it to the copy it
 * carries; a checkout leaves it unset, and the app is "not installed here"). `observed` is the integration register's dated
 * record of the owner's source (docs/integration/REGISTER.md), shown on the app's page as it was recorded.
 */

export type MiniAppKind = 'image' | 'video' | 'spatial' | 'stream' | 'motion';

/** What the page may say about an app: hostable (a source folder can be started), or waiting on a named step. */
export type MiniAppAvailability = 'hostable' | 'awaiting-owner-checkpoint' | 'no-owner';

export interface MiniAppSource {
  /** the owner, by the name of the chat or task that owns the app's code */
  owner: string;
  /** the revision the register recorded (a commit, plus uncommitted work where there was some) */
  revision: string;
  /** when it was recorded (an ISO date) */
  observedAt: string;
  /** what is still needed before Timmy imports it, in one line */
  next: string;
}

export interface MiniAppSpec {
  id: string;
  title: string;
  kind: MiniAppKind;
  /** one line: what the app is for */
  lead: string;
  availability: MiniAppAvailability;
  observed: MiniAppSource | null;
  /** hostable apps: the variable naming the app's folder, its entry file, the file its built page needs, and its env */
  host?: {
    sourceEnv: string;
    entry: string;
    builtFile: string;
    /** the path a readiness probe asks (GET, answered 200 when the app serves) */
    readyPath: string;
    /** the app's own variables: its port and data folder, and which of the companion's variables it may see */
    env: (a: { port: number; dataDir: string; base: Record<string, string | undefined> }) => Record<string, string>;
  };
}

/** Variables a hosted app may inherit from the companion, by name (never a provider key, token or the paid-call switch). */
const MODEL_STUDIO_PASS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
  // the tldraw license: the app serves it to its own page exactly as Timmy's app page does (never printed)
  'TLDRAW_LICENSE_KEY', 'STUDIO_TLDRAW_LICENSE_FILE',
  // the native engines' executables on this computer (Model Studio's server/native.mjs reads these first)
  'STUDIO_BLENDER', 'STUDIO_OPENSCAD', 'STUDIO_FREECAD', 'STUDIO_CAD_PYTHON', 'STUDIO_BUILD123D_PYTHON', 'STUDIO_C4DPY',
  'STUDIO_HYTHON', 'STUDIO_NATIVE_EVIDENCE_DIR', 'STUDIO_OLLAMA_URL',
] as const;

export const MINI_APPS: readonly MiniAppSpec[] = Object.freeze([
  {
    id: 'card-lab', title: 'Card Lab', kind: 'image',
    lead: 'Image analysis: inspect, research and decide on cards, with the broadcast controls for a reviewed card.',
    availability: 'awaiting-owner-checkpoint',
    observed: {
      owner: 'Codex: Timmy Card Lab (private standalone release)',
      revision: 'main 6431f8fb + 20 modified, 12 untracked (working tree, not committed)',
      observedAt: '2026-10-26',
      next: 'The owner commits the working tree on a checkpoint branch (private collections out of git); then Timmy imports that commit.',
    },
  },
  {
    id: 'film-room', title: 'Film Room', kind: 'video',
    lead: 'Video analysis: saved projects, clips, annotations and stats, with Airtable for data and notes.',
    availability: 'awaiting-owner-checkpoint',
    observed: {
      owner: 'Codex: Analyze NFL footage with AI',
      revision: 'main ecca8f44 + 21 modified, 107 untracked (working tree, not committed)',
      observedAt: '2026-10-26',
      next: 'The owner commits the working tree on a checkpoint branch, the private project kept outside it; then Timmy imports that commit.',
    },
  },
  {
    id: 'model-studio', title: 'Model Studio', kind: 'spatial',
    lead: 'The 3D workspace: sketch, image and generate, a real 3D viewport, native CAD engines, revisions and VoxVision inspection.',
    availability: 'hostable',
    observed: {
      owner: 'Codex: timmy-new-1',
      revision: 'codex/model-studio aabe7c1a (committed, clean)',
      observedAt: '2026-10-26',
      next: 'Hosted here as its owner built it. Timmy jobs, receipts and assets adapters are the next steps.',
    },
    host: {
      sourceEnv: 'TIMMY_MODEL_STUDIO_DIR',
      entry: 'server.mjs',
      builtFile: 'dist/index.html',
      readyPath: '/api/state',
      env: ({ port, dataDir, base }) => {
        const out: Record<string, string> = {};
        for (const k of MODEL_STUDIO_PASS) { const v = base[k]; if (typeof v === 'string' && v !== '') out[k] = v; }
        out.STUDIO_PORT = String(port);
        out.STUDIO_DATA_DIR = dataDir;
        // a hosted app never writes byte-code into an engine's environment it borrows (the owner's venvs stay as they are)
        out.PYTHONDONTWRITEBYTECODE = '1';
        return out;
      },
    },
  },
  {
    id: 'stream-studio', title: 'Stream Studio', kind: 'stream',
    lead: 'Streaming overlays and web pages, composed, animated and broadcast, built mostly in HTML with the agent.',
    availability: 'no-owner',
    observed: {
      owner: 'none assigned',
      revision: 'not built (Card Lab carries broadcast controls for reviewed cards; Timmy Animate carries the motion engine)',
      observedAt: '2026-10-26',
      next: 'One owner is assigned the general Compose → Animate → Broadcast editor.',
    },
  },
  {
    id: 'animate', title: 'Timmy Animate', kind: 'motion',
    lead: 'Motion paths, layers, states and exports: the engine behind Stream Studio’s animation.',
    availability: 'awaiting-owner-checkpoint',
    observed: {
      owner: 'Codex: Assess a 2D animator mini app',
      revision: 'never committed (companion/animate in a separate local checkout)',
      observedAt: '2026-10-26',
      next: 'The owner commits it (its own repository or branch); then Timmy imports that commit.',
    },
  },
] as MiniAppSpec[]);

export const miniAppOf = (id: string): MiniAppSpec | undefined => MINI_APPS.find((a) => a.id === id);
