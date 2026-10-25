import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const FRAMER_MCP_URL = 'https://mcp.framer.com/mcp';
export const HELP = `TIMMY Framer — official remote MCP through the installed MCPorter

  timmy framer init                         Create an isolated local config
  timmy framer auth                         Complete Framer OAuth in your browser
  timmy framer tools                        Discover the live tools and schemas
  timmy framer call <tool> <json-file>       Call any discovered tool
  timmy framer open <project-url-or-id>      Obtain a project session and README
  timmy framer docs <session> <doc-path>     Read project instructions
  timmy framer exec <session> <js-file>      Execute a project script
  timmy framer status <session>             Read publish readiness and changes
  timmy framer publish <session>            Publish to the server-selected target
  timmy framer types <output.ts>            Generate a typed MCP client
  timmy framer generate-cli <output.js>     Bundle all discovered tools as a CLI
  timmy framer motion <output.tsx>          Create an editable Motion example

Read the README returned by open and its required docs before exec/publish.
Publishing can update production. Inspect status first. Staging deployment
requires a separate explicit exec with the exact version from status.
Motion renders in a browser, not in an ANSI terminal. Motion+ is separate.
TIMMY_FRAMER_CONFIG selects an existing MCPorter config; default:
.timmy/private/framer/mcporter.json. Authenticate before generating clients.
`;

export function ensureConfig(cwd: string, override = process.env.TIMMY_FRAMER_CONFIG): string {
  if (override) {
    const selected = path.resolve(cwd, override);
    if (!fs.statSync(selected).isFile()) throw new Error('TIMMY_FRAMER_CONFIG must be a file');
    return selected;
  }
  const directory = path.join(cwd, '.timmy/private/framer');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = path.join(directory, 'mcporter.json');
  try {
    fs.writeFileSync(config, JSON.stringify({ mcpServers: {
      framer: { baseUrl: FRAMER_MCP_URL, auth: 'oauth' },
    }, imports: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return config;
}

function required(args: string[], count: number): void {
  if (args.length !== count || args.some(arg => !arg || arg.startsWith('--'))) {
    throw new Error('Invalid arguments. Run timmy framer --help.');
  }
}

export function planCommand(argv: string[], cwd: string): string[] {
  const [verb, ...args] = argv;
  const call = (tool: string, payload: object) => [
    'call', `framer.${tool}`, '--args', JSON.stringify(payload),
    '--output', 'json', '--no-oauth', '--timeout', '120000',
  ];
  switch (verb) {
    case 'auth': required(args, 0); return ['auth', 'framer'];
    case 'tools': required(args, 0); return ['list', 'framer', '--schema', '--json', '--no-oauth', '--exit-code'];
    case 'open': required(args, 1); return call('open_project', { projectId: args[0] });
    case 'docs': required(args, 2); return call('read_docs', { session: args[0], path: args[1] });
    case 'exec': required(args, 2); return call('exec', {
      session: args[0], program: fs.readFileSync(path.resolve(cwd, args[1]), 'utf8'),
    });
    case 'status': required(args, 1); return call('exec', {
      session: args[0], program: 'return await api.publishing.status()',
    });
    case 'publish': required(args, 1); return call('exec', {
      session: args[0], program: `const status = await api.publishing.status();
if (status.status !== "ready") throw new Error(JSON.stringify({ published: false, status }));
return await api.publishing.publish();`,
    });
    case 'call': {
      required(args, 2);
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(args[0])) throw new Error('Use an exact discovered tool name');
      const payload: unknown = JSON.parse(fs.readFileSync(path.resolve(cwd, args[1]), 'utf8'));
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Tool arguments must be a JSON object');
      return call(args[0], payload);
    }
    case 'types': required(args, 1); return ['emit-ts', 'framer', '--mode', 'client', '--out', path.resolve(cwd, args[0])];
    case 'generate-cli': required(args, 1); return ['generate-cli', 'framer', '--runtime', 'node', '--bundle', path.resolve(cwd, args[0])];
    default: throw new Error(`Unknown Framer command: ${verb}. Run timmy framer --help.`);
  }
}

export function motionSource(): string {
  return `import * as React from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";

/** Editable browser component. Install motion in the consuming React project.
 * The caller supplies actual state; this component does not verify receipts.
 */
export default function TimmyMotionStatus({ label = "Ready", detail = "No operation running" }) {
  const reduce = useReducedMotion();
  const [expanded, setExpanded] = React.useState(false);
  const id = React.useId();
  return (
    <motion.section layout={!reduce} style={{ padding: 24, fontFamily: "inherit", color: "inherit" }}>
      <motion.button type="button" aria-expanded={expanded} aria-controls={id}
        onClick={() => setExpanded(value => !value)}
        whileHover={reduce ? undefined : { scale: 1.02 }}
        whileTap={reduce ? undefined : { scale: 0.98 }}>
        {label}
      </motion.button>
      <AnimatePresence initial={false}>
        {expanded && <motion.p key="detail" id={id}
          initial={{ opacity: reduce ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}>{detail}</motion.p>}
      </AnimatePresence>
    </motion.section>
  );
}
`;
}

export async function framerMain(argv: string[], cwd = process.cwd()): Promise<number> {
  try {
    if (!argv.length || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) {
      console.log(HELP); return 0;
    }
    if (argv[0] === 'motion') {
      required(argv.slice(1), 1);
      const target = path.resolve(cwd, argv[1]);
      fs.writeFileSync(target, motionSource(), { flag: 'wx' });
      console.log(JSON.stringify({ created: target, runtime: 'browser', dependency: 'motion', deployed: false }));
      return 0;
    }
    if (argv[0] === 'init') {
      required(argv.slice(1), 0);
      console.log(JSON.stringify({ config: ensureConfig(cwd), authenticated: 'unknown', next: 'timmy framer auth' }));
      return 0;
    }
    // Validate before creating config or starting a child. Never interpolate a shell.
    const command = planCommand(argv, cwd);
    if (['types', 'generate-cli'].includes(argv[0]) && fs.existsSync(path.resolve(cwd, argv[1]))) {
      throw new Error('Output already exists; choose a new path');
    }
    const executable = fileURLToPath(import.meta.resolve('mcporter/cli'));
    const config = ensureConfig(cwd);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [executable, '--config', config, ...command], {
        cwd, stdio: 'inherit', shell: false,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (signal) console.error(`MCPorter terminated by ${signal}`);
        resolve(code ?? 1);
      });
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
