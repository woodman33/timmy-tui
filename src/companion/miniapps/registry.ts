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

/** One of an app's own jobs that has ended, as the app's state reports it (never upgraded here). */
export interface FinishedAppJob {
  id: string;
  kind: string;
  /** the app's own word: succeeded, failed, cancelled or interrupted */
  status: string;
  label: string;
  error?: string;
  files: Array<{ assetId: string; filename: string }>;
  /** the app's record of the job, exactly as it reported it (its hash is sealed; the record is not) */
  raw: unknown;
}

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
    /**
     * How Timmy reads the app's finished jobs for its canonical receipts (./receipts.ts): the path of the app's state, and
     * each finished job in it with the files it made (an asset id and file name the app serves at /api/assets/<id>/<file>).
     * Absent: the app's jobs are not sealed by Timmy.
     */
    receipts?: { statePath: string; finished: (state: unknown) => FinishedAppJob[] };
  };
}

/** Variables every hosted app may inherit from the companion, by name (never a provider key, token or paid-call switch). */
const BASE_PASS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
  // the tldraw license: each app serves it to its own page exactly as Timmy's app page does (never printed)
  'TLDRAW_LICENSE_KEY'] as const;

/** An app's environment: the base names and its own allowed names from the companion's, then its port and data folder. */
function envOf(base: Record<string, string | undefined>, extra: readonly string[], set: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...BASE_PASS, ...extra]) { const v = base[k]; if (typeof v === 'string' && v !== '') out[k] = v; }
  // a hosted app never writes byte-code into an engine's environment it borrows (an owner's venvs stay as they are)
  out.PYTHONDONTWRITEBYTECODE = '1';
  return { ...out, ...set };
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export const MINI_APPS: readonly MiniAppSpec[] = Object.freeze([
  {
    id: 'card-lab', title: 'Card Lab', kind: 'image',
    lead: 'Image analysis: inspect, research and decide on cards, with the broadcast controls for a reviewed card.',
    availability: 'hostable',
    observed: {
      owner: 'Codex: Timmy Card Lab (private standalone release)',
      revision: 'codex/card-lab-checkpoint 7176ad97 (owner checkpoint of 6431f8fb + its working tree)',
      observedAt: '2026-10-26',
      next: 'Hosted in local mode as its owner built it. Its own app suite timed out at the owner (120 s, 90 s); shared jobs, assets, approvals and receipts are still to map.',
    },
    host: {
      sourceEnv: 'TIMMY_CARD_LAB_DIR',
      entry: 'bin/timmy-card-lab.mjs',
      builtFile: 'frontend/dist/index.html',
      readyPath: '/api/health',
      // local mode only (loopback, no hosted sign-in); no provider token reaches it (CARDLAB_*_TOKEN and keys are not passed)
      env: ({ port, dataDir, base }) => envOf(base, ['CARDLAB_TLDRAW_LICENSE_FILE', 'CARDLAB_OLLAMA_ORIGIN', 'CARDLAB_OLLAMA_MODEL'], {
        CARDLAB_PORT: String(port), CARDLAB_DATA_DIR: dataDir, CARDLAB_MODE: 'local', CARDLAB_BIND_HOST: '127.0.0.1',
      }),
    },
  },
  {
    id: 'film-room', title: 'Film Room', kind: 'video',
    lead: 'Video analysis: saved projects, clips, annotations and stats, with Airtable for data and notes.',
    availability: 'hostable',
    observed: {
      owner: 'Codex: Analyze NFL footage with AI',
      revision: 'codex/film-room-checkpoint f9db9fe0 (131/131 app tests at the owner)',
      observedAt: '2026-10-26',
      next: 'Hosted as its owner built it, blank; the owner’s private project stays outside. Airtable and Roboflow need their own sign-ins here; shared jobs, assets and receipts are still to map.',
    },
    host: {
      sourceEnv: 'TIMMY_FILM_ROOM_DIR',
      entry: 'server.mjs',
      builtFile: 'dist/index.html',
      readyPath: '/api/config',
      env: ({ port, dataDir, base }) => envOf(base, ['FILMROOM_TLDRAW_LICENSE_FILE', 'FILMROOM_FFMPEG', 'FILMROOM_PYTHON', 'FILMROOM_MAX_UPLOAD_BYTES'], {
        PORT: String(port), FILMROOM_DATA_DIR: dataDir,
      }),
    },
  },
  {
    id: 'model-studio', title: 'Model Studio', kind: 'spatial',
    lead: 'The 3D workspace: sketch, image and generate, a real 3D viewport, native CAD engines, revisions and VoxVision inspection.',
    availability: 'hostable',
    observed: {
      owner: 'Codex: timmy-new-1',
      revision: 'codex/model-studio a5264eb5 (clean-clone build and cancellation fix over aabe7c1a)',
      observedAt: '2026-10-26',
      next: 'Hosted here as its owner built it; its ended jobs are sealed as Timmy receipts.',
    },
    host: {
      sourceEnv: 'TIMMY_MODEL_STUDIO_DIR',
      entry: 'server.mjs',
      builtFile: 'dist/index.html',
      readyPath: '/api/state',
      // the native engines' executables on this computer (Model Studio's server/native.mjs reads these first)
      env: ({ port, dataDir, base }) => envOf(base, ['STUDIO_TLDRAW_LICENSE_FILE', 'STUDIO_BLENDER', 'STUDIO_OPENSCAD', 'STUDIO_FREECAD', 'STUDIO_CAD_PYTHON', 'STUDIO_BUILD123D_PYTHON', 'STUDIO_C4DPY', 'STUDIO_HYTHON', 'STUDIO_NATIVE_EVIDENCE_DIR', 'STUDIO_OLLAMA_URL'], {
        STUDIO_PORT: String(port), STUDIO_DATA_DIR: dataDir,
      }),
      // Model Studio's state (docs/CONTRACT.md): jobs {id,kind,status,engine,error?,result?:{asset:{id,previewFilename,nativeFilename}}}
      receipts: {
        statePath: '/api/state',
        finished: (state) => {
          const jobs = (state as { jobs?: unknown[] } | null)?.jobs;
          if (!Array.isArray(jobs)) return [];
          return jobs.flatMap((j) => {
            const o = j as { id?: unknown; kind?: unknown; status?: unknown; engine?: unknown; error?: unknown; result?: { asset?: { id?: unknown; previewFilename?: unknown; nativeFilename?: unknown } } };
            if (typeof o.id !== 'string' || typeof o.status !== 'string' || !ENDED.has(o.status)) return [];
            const a = o.result?.asset;
            const files = a && typeof a.id === 'string'
              ? [a.previewFilename, a.nativeFilename].filter((f): f is string => typeof f === 'string' && /^[\w.-]+$/.test(f)).map((filename) => ({ assetId: a.id as string, filename }))
              : [];
            const kind = typeof o.kind === 'string' ? o.kind : 'job';
            return [{ id: o.id, kind, status: o.status, label: `${kind}${typeof o.engine === 'string' ? ` ${o.engine}` : ''}`, ...(typeof o.error === 'string' ? { error: o.error.slice(0, 300) } : {}), files, raw: j }];
          });
        },
      },
    },
  },
  {
    id: 'stream-studio', title: 'Stream Studio', kind: 'stream',
    lead: 'Streaming overlays and web pages, composed, animated and broadcast, built mostly in HTML with the agent.',
    availability: 'no-owner',
    observed: {
      owner: 'none assigned',
      revision: 'not built (Card Lab carries broadcast controls for reviewed cards; Timmy Animate carries the motion engine and exports)',
      observedAt: '2026-10-26',
      next: 'One owner is assigned the general Compose → Animate → Broadcast editor.',
    },
  },
  {
    id: 'animate', title: 'Timmy Animate', kind: 'motion',
    lead: 'Motion paths, layers, states and exports: the engine behind Stream Studio’s animation.',
    availability: 'hostable',
    observed: {
      owner: 'Codex: Assess a 2D animator mini app',
      revision: 'v6 source archive (payload manifest 68c2f853; no commit; 59/59 app tests at the owner)',
      observedAt: '2026-10-26',
      next: 'Hosted as its owner built it. Its `timmy animate` command, agent tools and MCP registration are not imported yet.',
    },
    host: {
      sourceEnv: 'TIMMY_ANIMATE_DIR',
      entry: 'server.mjs',
      builtFile: 'dist/index.html',
      readyPath: '/api/health',
      env: ({ port, dataDir, base }) => envOf(base, ['ANIMATE_TLDRAW_LICENSE_FILE', 'ANIMATE_BLENDER'], {
        PORT: String(port), ANIMATE_DATA_DIR: dataDir,
      }),
    },
  },
] as MiniAppSpec[]);

export const miniAppOf = (id: string): MiniAppSpec | undefined => MINI_APPS.find((a) => a.id === id);
