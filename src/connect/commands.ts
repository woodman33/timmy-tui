/**
 * Round R4 (helper H90): Timmy Connect's verbs, once, for both surfaces: `timmy connect …` (src/connect/cli.ts) and the
 * REPL's `/connect …` (src/connect/repl.ts). Each verb returns lines to print (Timmy Homebrew roles: labels secondary,
 * commands amber (B10), outcome words in the text colour), one JSON object (`--json`), and an exit code: 0 done, 1 refused or
 * not answered, 2 usage, 130 a Ctrl-C during a wait. The JSON's device and job objects are readConnect's own (read.ts),
 * so a job's state reads the same in the CLI's JSON, the REPL's words and God's Eye View.
 */
import type { ApprovalRequest, Decision, WaitingApproval } from '../repl/approvals.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { addDevice, DEFAULT_REMOTE_DIR, removeDevice } from './devices.js';
import { fingerprintOf, keyLabel, pendingKeys, scanDevice, scanHost, trustKey } from './hostkeys.js';
import { fetchFile, listJobs, readJob, reconcileJob, retryJob, runJob, stopJob, waitJob, type JobOutcome } from './jobs.js';
import { probeDevice } from './probe.js';
import { deviceView, jobView, readConnect } from './read.js';
import { scrubShown } from './scrub.js';
import { overrideWords, sshVersion } from './ssh.js';
import { connectPaths, findDevice, readDevices, shown, type ConnectPaths } from './store.js';
import { readTailnet } from './tailnet.js';
import { REMOTE_JOB_ID } from './validate.js';
import { deviceNeeds, deviceWords, when } from './words.js';

export type Line = Segment[];

export interface ConnectContext {
  /** Timmy home (TIMMY_HOME or ~/timmy when absent) */
  home?: string;
  glyphs: GlyphSet;
  /** which surface asks: the CLI confirms a host key by its exact fingerprint, the REPL through its approval box */
  by: 'cli' | 'repl';
  /**
   * whether the CLI's stdin is a terminal (src/connect/cli.ts sets it). The CLI's `trust` needs one: a person types the
   * fingerprint there; from a pipe (a script, an agent's plain command) nothing is pinned. Absent: not a terminal.
   */
  terminal?: boolean;
  /** the folder a relative --to is resolved from */
  cwd?: string;
  /** the REPL's NEEDS YOU box (src/repl/approvals.ts askPerson wraps it); absent where no one can be asked */
  ask?: (req: ApprovalRequest, words: WaitingApproval['words']) => Promise<Decision>;
  /** a Ctrl-C during a wait (the CLI's SIGINT) */
  signal?: AbortSignal;
  /** a line said while a wait runs (the device's "still running") */
  progress?: (line: Line) => void;
}

export interface Said { code: number; lines: Line[]; json: Record<string, unknown> }

export const VERBS = ['add', 'scan', 'trust', 'devices', 'list', 'remove', 'probe', 'run', 'jobs', 'status', 'wait', 'retry', 'stop', 'fetch', 'tailnet', 'help'] as const;

/** Whether an argument list is Timmy Connect's (a verb, help, or nothing); any other first word is the older `timmy connect <tool>`. */
export function isConnectVerb(args: readonly string[]): boolean {
  const first = args.find((a) => a !== '--json');
  return first === undefined || first === '--help' || first === '-h' || (VERBS as readonly string[]).includes(first);
}

export function connectHelp(surface: 'cli' | 'repl' = 'cli'): string[] {
  const c = surface === 'cli' ? 'timmy connect' : '/connect';
  return [
    `${c}: your own computers over SSH (Timmy Connect, slice 1)`,
    '',
    `  ${c} add <id> [<user>@]<address> [--user <name>] [--port <n>] (--key <file> | --agent)`,
    `      [--name <text>] [--remote-dir <dir>] [--account-ssh-config]   record it; fetch its host keys (none trusted)`,
    `  ${c} scan <id>                fetch its host keys again`,
    surface === 'cli'
      ? `  ${c} trust <id> SHA256:<…>   you confirm that exact fingerprint (one just fetched), typed in a terminal`
      : `  ${c} trust <id> [SHA256:<…>] you confirm a fetched key in the NEEDS YOU box`,
    `  ${c} devices                  the computers, their keys and last probes (no contact)`,
    `  ${c} remove <id>              forget it here (nothing on it changes)`,
    `  ${c} probe <id>               what it is, its job folder, what is on its PATH`,
    `  ${c} run <id>${surface === 'cli' ? ' [--wait]' : ''} -- <command…>   a job that outlives the connection`,
    `  ${c} run <id>${surface === 'cli' ? ' [--wait]' : ''} --script <file>  (it goes on stdin; its sha256 is recorded)`,
    `  ${c} jobs                     remote jobs as last read (no contact)`,
    `  ${c} status <job>             reads its status on the computer, then says it`,
    ...(surface === 'cli' ? [`  ${c} wait <job>               waits for its end (Ctrl-C stops only the waiting)`] : []),
    `  ${c} retry <job>              sends it again only if the computer has no run of it`,
    `  ${c} stop <job>               stops it there (its pid's start time checked first)`,
    `  ${c} fetch <job> <path> [--to <file>]   a file of its folder, sha256 checked on both`,
    `  ${c} tailnet                  peers tailscale status lists (read only; adds nothing)`,
    ...(surface === 'cli' ? [`  ${c} <tool>                   any other word: the journey's env.lock step, as before`] : []),
    '',
    '  --json on each: one JSON object. Exit: 0 done, 1 refused or no answer, 2 usage, 130 Ctrl-C during a wait;',
    '  a wait exits 0 only when the job ended with exit 0 there.',
    "  ssh runs with Timmy's own empty config and known_hosts, BatchMode and StrictHostKeyChecking=yes; a key is named",
    '  by its file, never read by Timmy. A connection proves no CAD, rendering, GPU or app support.',
  ];
}

interface Parsed { verb: string; pos: string[]; flags: Map<string, string | true>; command?: string[]; json: boolean }

const VALUE_FLAGS = new Set(['--user', '--port', '--key', '--name', '--remote-dir', '--script', '--to']);
const BOOL_FLAGS = new Set(['--json', '--wait', '--agent', '--account-ssh-config', '--help', '-h']);

function parse(args: readonly string[]): Parsed | { error: string } {
  const dash = args.indexOf('--');
  const head = dash < 0 ? [...args] : args.slice(0, dash);
  const command = dash < 0 ? undefined : args.slice(dash + 1);
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (VALUE_FLAGS.has(a)) {
      const v = head[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      flags.set(a, v);
      i++;
    } else if (BOOL_FLAGS.has(a)) flags.set(a, true);
    else if (a.startsWith('-') && a.length > 1) return { error: `unknown option ${a}` };
    else pos.push(a);
  }
  const verb = pos.shift() ?? 'help';
  return { verb, pos, flags, ...(command ? { command } : {}), json: flags.has('--json') };
}

const label = (text: string): Segment => ({ text, role: 'secondary' });
const cmd = (text: string): Segment => ({ text, role: 'accent' });

function usage(error: string, json: boolean): Said {
  return { code: 2, json: { ok: false, error, usage: connectHelp() }, lines: [[{ text: `  ${error}` }], [label('  '), cmd('timmy connect help'), label(' lists the verbs')]] };
}

function deviceLines(d: ReturnType<typeof deviceView>, g: GlyphSet): Line[] {
  const lines: Line[] = [[{ text: `  ${d.id}`, role: 'strong' }, label(`  ${d.name !== d.id ? `${d.name} · ` : ''}`), { text: d.words }]];
  for (const need of d.needs) lines.push([{ text: `    ${g.warn} `, role: 'estimate' }, { text: need }]);
  return lines;
}

function jobLines(j: ReturnType<typeof jobView>, g: GlyphSet): Line[] {
  const mark = j.state === 'running' ? g.bullet : j.state === 'unknown' || j.state === 'stop asked' ? g.warn : j.state === 'submitted' ? '·' : g.ok;
  return [[{ text: `  ${mark} ` }, { text: j.id, role: 'strong' }, label(`  ${j.label}  `), { text: j.words }]];
}

function failLine(g: GlyphSet, words: string): Line { return [{ text: `  ${g.fail} `, role: 'failure' }, { text: words }]; }
function okLine(g: GlyphSet, words: string): Line { return [{ text: `  ${g.ok} `, role: 'verified' }, { text: words }]; }

function outcomeSaid(r: JobOutcome | { error: string }, verb: string, g: GlyphSet, okCode = 0): Said {
  if ('error' in r) return { code: 1, lines: [failLine(g, r.error)], json: { ok: false, verb, error: scrubShown(r.error) } };
  const view = jobView(r.job);
  const words = scrubShown(r.words);
  // the job's line says its state; a second line only when this verb's words say more (not sent, refused, a stop's result)
  const lines: Line[] = [...jobLines(view, g), ...(words !== view.words ? [[label('    '), { text: words }]] : [])];
  if (r.failure?.ssh) lines.push([label('    ssh: '), { text: r.failure.ssh.split('\n').slice(-3).join(' / ') }]);
  for (const t of r.job.remote?.tail ?? []) lines.push([label('    out| '), { text: t }]);
  if (r.job.state === 'running' || r.job.state === 'stop asked' || r.job.state === 'unknown') lines.push([label('    '), cmd(`timmy connect status ${r.job.id}`), label('  '), cmd(`timmy connect stop ${r.job.id}`)]);
  const code = (r.failure && !r.answered) || r.refused ? 1 : okCode;
  return { code, lines, json: { ok: code === 0, verb, job: view, words: scrubShown(r.words), ...(r.failure ? { failure: { outcome: r.failure.outcome, ...(r.failure.why ? { why: r.failure.why } : {}), words: r.failure.words, ssh: r.failure.ssh } } : {}), ...(r.job.remote?.tail ? { tail: r.job.remote.tail } : {}) } };
}

/** One `timmy connect …` or `/connect …`, run. */
export async function connectDo(args: readonly string[], c: ConnectContext): Promise<Said> {
  const parsed = parse(args);
  if ('error' in parsed) return usage(parsed.error, args.includes('--json'));
  const { verb, pos, flags, command, json } = parsed;
  const g = c.glyphs;
  const p: ConnectPaths = connectPaths(c.home);
  const want = (n: number, form: string): Said | null => (pos.length === n ? null : usage(`usage: ${c.by === 'cli' ? 'timmy connect' : '/connect'} ${verb} ${form}`, json));
  const jobArg = (): string | Said => {
    const bad = want(1, '<job>');
    if (bad) return bad;
    return REMOTE_JOB_ID.test(pos[0]) ? pos[0] : usage(`${JSON.stringify(pos[0])} is not a remote job id (r and 8 hex digits)`, json);
  };
  if (flags.has('--help') || flags.has('-h') || verb === 'help') return { code: 0, lines: connectHelp(c.by).map((t) => [{ text: t }]), json: { ok: true, verb: 'help', usage: connectHelp(c.by) } };

  switch (verb) {
    case 'add': {
      const bad = want(2, '<id> [<user>@]<address> (--key <file> | --agent) [--user <name>] [--port <n>]');
      if (bad) return bad;
      let [id, address] = pos;
      let user = typeof flags.get('--user') === 'string' ? flags.get('--user') as string : undefined;
      const at = address.lastIndexOf('@');
      if (at > 0) { user ??= address.slice(0, at); address = address.slice(at + 1); }
      if (!user) return usage('a user is needed: --user <name>, or <user>@<address>', json);
      const key = flags.get('--key');
      const agent = flags.has('--agent');
      if ((typeof key === 'string') === agent) return usage('name the key ssh is to use: --key <private key file>, or --agent (the ssh agent\'s keys)', json);
      const portText = flags.get('--port');
      const port = typeof portText === 'string' ? Number(portText) : 22;
      const added = addDevice(p, { id, address, user, port, identity: agent ? 'agent' : key as string, ...(typeof flags.get('--name') === 'string' ? { name: flags.get('--name') as string } : {}), ...(typeof flags.get('--remote-dir') === 'string' ? { remoteDir: flags.get('--remote-dir') as string } : {}), accountConfig: flags.has('--account-ssh-config') });
      if (!added.device) return { code: 2, lines: added.problems.map((x) => failLine(g, `not added: ${x}`)), json: { ok: false, verb, problems: added.problems } };
      const scan = await scanDevice(p, id);
      const lines: Line[] = [okLine(g, `added ${id}: ${added.device.user}@${added.device.address}:${added.device.port}, ${added.device.identity === 'agent' ? 'the ssh agent\'s keys' : `key ${added.device.identity} (Timmy passes its name to ssh and never reads it)`}, job folder ${added.device.remote_dir}${added.device.ssh_config === 'account' ? '; ssh uses your own ssh config (~/.ssh/config)' : ''}`)];
      if ('error' in scan) lines.push(failLine(g, scan.error));
      else {
        lines.push([label('  '), { text: scan.words }]);
        for (const k of scan.keys) lines.push([label(`    ${k.label.padEnd(8)} `), { text: k.fingerprint, role: 'strong' }]);
        // no ready command holds a fetched fingerprint: the person reads it on the computer itself and types what they read
        if (scan.keys.length) {
          lines.push(c.by === 'cli'
            ? [label('  Read its fingerprint on the computer itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub there); if it is one of these, type in a terminal: '), cmd(`timmy connect trust ${id} SHA256:<the fingerprint as you read it there>`)]
            : [label('  Read its fingerprint on the computer itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub there), then: '), cmd(`/connect trust ${id}`)]);
        } else lines.push([label('  When it answers: '), cmd(`timmy connect scan ${id}`)]);
      }
      const device = findDevice(p, id).device ?? added.device;
      return { code: 0, lines, json: { ok: true, verb, device: deviceView(device), scan: 'error' in scan ? { error: scan.error } : { keys: scan.scan.keys, words: scan.words } } };
    }
    case 'scan': {
      const bad = want(1, '<id>');
      if (bad) return bad;
      const scan = await scanDevice(p, pos[0]);
      if ('error' in scan) return { code: 1, lines: [failLine(g, scan.error)], json: { ok: false, verb, error: scan.error } };
      const lines: Line[] = [[label('  '), { text: scan.words }], ...scan.keys.map((k): Line => [label(`    ${k.label.padEnd(8)} `), { text: k.fingerprint, role: 'strong' }])];
      if (scan.keys.length) lines.push([label('  To confirm one: '), cmd(c.by === 'cli' ? `timmy connect trust ${pos[0]} SHA256:<…>` : `/connect trust ${pos[0]}`)]);
      return { code: scan.ok ? 0 : 1, lines, json: { ok: scan.ok, verb, device: deviceView(scan.device), scan: { keys: scan.scan.keys, words: scan.words } } };
    }
    case 'trust': {
      if (pos.length < 1 || pos.length > 2) return usage(`usage: ${c.by === 'cli' ? 'timmy connect trust <id> SHA256:<…>' : '/connect trust <id> [SHA256:<…>]'}`, json);
      const [id, given] = pos;
      if (c.by === 'cli' && !given) return usage('confirm the exact fingerprint: timmy connect trust <id> SHA256:<…> (timmy connect scan <id> shows the fetched ones)', json);
      if (c.by === 'repl') {
        // the REPL asks in Timmy's approval box: the person reads the fingerprint there and answers y
        const found = findDevice(p, id);
        if (!found.device) return { code: 1, lines: [failLine(g, found.error ?? `no device ${id}`)], json: { ok: false, verb, error: found.error } };
        const d = found.device;
        const pending = pendingKeys(p, id).filter((k) => k.host === scanHost(d.address, d.port)).map((k) => ({ type: keyLabel(k.type), fingerprint: fingerprintOf(k.blob) }));
        const key = given ? pending.find((k) => k.fingerprint === given) : pending[0];
        if (!key) {
          const why = given ? `${given} is not among the keys fetched from ${d.address}:${d.port}${pending.length ? ` (${pending.map((k) => k.fingerprint).join(', ')})` : ''}: nothing was trusted` : `no host key of ${d.address}:${d.port} is waiting for a person: /connect scan ${id} fetches them; nothing was trusted`;
          return { code: 1, lines: [failLine(g, why)], json: { ok: false, verb, error: why } };
        }
        if (!c.ask) {
          const why = 'no NEEDS YOU box here (not at a terminal): nothing was trusted; in a terminal, timmy connect trust <id> SHA256:<…>';
          return { code: 1, lines: [failLine(g, why)], json: { ok: false, verb, error: why } };
        }
        const decision = await c.ask({
          tool: 'connect trust', session: false,
          reason: `pins this host key for ${id}: Timmy's ssh will then accept only this key from ${d.address}:${d.port}`,
          summary: `${id} ${key.type} ${key.fingerprint}`,
          detail: [`device       ${id} (${d.user}@${d.address}:${d.port})`, `key          ${key.type}`, `fingerprint  ${key.fingerprint}`, `fetched      ${when(d.host_key_scan?.at)}`, d.host_key ? `replaces     ${d.host_key.type} ${d.host_key.fingerprint} (confirmed ${when(d.host_key.confirmed_at)})` : 'replaces     nothing (no key confirmed yet)', 'Check it on the computer itself first: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'].join('\n'),
        }, { title: `Confirm ${id}'s host key`, needed: `confirm ${key.type} ${key.fingerprint} for ${id}`, why: 'Timmy trusts no host key until a person confirms its fingerprint', commands: [`/connect trust ${id} ${key.fingerprint}`], keys: true });
        if (decision === 'deny') return { code: 1, lines: [failLine(g, `not confirmed: ${id}'s host key stays unconfirmed; nothing was trusted`)], json: { ok: false, verb, decision } };
        const r = trustKey(p, id, key.fingerprint, 'repl');
        return { code: r.ok ? 0 : 1, lines: [r.ok ? okLine(g, `${r.words}${r.receipt ? `; receipt ${r.receipt}` : ''}`) : failLine(g, r.words)], json: { ok: r.ok, verb, words: r.words, ...(r.device ? { device: deviceView(r.device) } : {}), ...(r.receipt ? { receipt: r.receipt } : {}) } };
      }
      // the CLI pins a host key only for a person at a terminal: from a pipe (a script, an agent's plain command) it refuses
      if (!c.terminal) {
        const why = `not trusted: timmy connect trust needs a person at a terminal (its stdin is not one here), so a script or an agent's command cannot pin a host key; nothing was trusted. Read the fingerprint on the computer itself, then type the command in a terminal, or use /connect trust ${id} in Timmy's REPL (its NEEDS YOU box)`;
        return { code: 1, lines: [failLine(g, why)], json: { ok: false, verb, error: why } };
      }
      const r = trustKey(p, id, given!, 'cli');
      return { code: r.ok ? 0 : 1, lines: [r.ok ? okLine(g, `${r.words}${r.receipt ? `; receipt ${r.receipt}` : ''}`) : failLine(g, r.words)], json: { ok: r.ok, verb, words: r.words, ...(r.device ? { device: deviceView(r.device) } : {}), ...(r.receipt ? { receipt: r.receipt } : {}) } };
    }
    case 'devices':
    case 'list': {
      const view = readConnect(c.home);
      const lines: Line[] = view.devices.length ? view.devices.flatMap((d) => deviceLines(d, g)) : [[label('  No computers yet: '), cmd(`${c.by === 'cli' ? 'timmy connect' : '/connect'} add <id> <user>@<address> --key <file>`)]];
      for (const u of view.unreadable) lines.push(failLine(g, `${u.record}: unknown (${u.why})`));
      return { code: 0, lines, json: { ok: true, verb: 'devices', devices: view.devices, unreadable: view.unreadable } };
    }
    case 'remove': {
      const bad = want(1, '<id>');
      if (bad) return bad;
      const r = removeDevice(p, pos[0]);
      return { code: r.removed ? 0 : 1, lines: [r.removed ? okLine(g, r.words) : failLine(g, r.words)], json: { ok: Boolean(r.removed), verb, words: r.words } };
    }
    case 'probe': {
      const bad = want(1, '<id>');
      if (bad) return bad;
      const r = await probeDevice(p, pos[0]);
      if ('error' in r) return { code: 1, lines: [failLine(g, r.error)], json: { ok: false, verb, error: r.error } };
      const ok = r.probe.outcome === 'connected';
      const lines: Line[] = [ok ? okLine(g, r.probe.words) : failLine(g, r.probe.words)];
      if (r.ssh) lines.push([label('    ssh: '), { text: r.ssh.split('\n').slice(-4).join(' / ') }]);
      if (r.device.ssh_config === 'account') lines.push([label(`    ssh used your own ssh config (~/.ssh/config), as this device asks; ${overrideWords(await sshVersion())}`)]);
      for (const need of deviceNeeds(r.device)) lines.push([{ text: `    ${g.warn} `, role: 'estimate' }, { text: need }]);
      return { code: ok ? 0 : 1, lines, json: { ok, verb, outcome: r.probe.outcome, ...(r.probe.why ? { why: r.probe.why } : {}), words: r.probe.words, ...(r.probe.facts ? { facts: r.probe.facts } : {}), ...(r.ssh ? { ssh: r.ssh } : {}), device: deviceView(r.device) } };
    }
    case 'run': {
      const bad = want(1, '<id> [--wait] (-- <command…> | --script <file>)');
      if (bad) return bad;
      const script = flags.get('--script');
      if ((typeof script === 'string') === Boolean(command?.length)) return usage('give either -- <command…> or --script <file>', json);
      if (flags.has('--wait') && c.by === 'repl') return usage('/connect run has no --wait in the REPL: /connect status <job> reads it, or timmy connect wait <job> in a terminal', json);
      const r = await runJob(p, pos[0], typeof script === 'string' ? { scriptFile: script } : { command: command! });
      if ('error' in r || !flags.has('--wait') || r.job.state !== 'running') return outcomeSaid(r, verb, g);
      return waited(p, r.job.id, c, outcomeSaid(r, verb, g).lines);
    }
    case 'jobs': {
      const jobs = listJobs(p).map(jobView);
      const lines: Line[] = jobs.length ? jobs.flatMap((j) => jobLines(j, g)) : [[label('  No remote jobs yet: '), cmd(`${c.by === 'cli' ? 'timmy connect' : '/connect'} run <id> -- <command…>`)]];
      if (jobs.length) lines.push([label('  As last read (no computer was contacted): '), cmd(`${c.by === 'cli' ? 'timmy connect' : '/connect'} status <job>`), label(' reads one now')]);
      return { code: 0, lines, json: { ok: true, verb, jobs } };
    }
    case 'status': {
      const id = jobArg();
      if (typeof id !== 'string') return id;
      return outcomeSaid(await reconcileJob(p, id), verb, g);
    }
    case 'retry': {
      const id = jobArg();
      if (typeof id !== 'string') return id;
      return outcomeSaid(await retryJob(p, id), verb, g);
    }
    case 'wait': {
      if (c.by === 'repl') return usage('/connect has no wait in the REPL: /connect status <job> reads it, or timmy connect wait <job> in a terminal', json);
      const id = jobArg();
      if (typeof id !== 'string') return id;
      if (!readJob(p, id)) return { code: 1, lines: [failLine(g, `no remote job ${id}`)], json: { ok: false, verb, error: `no remote job ${id}` } };
      return waited(p, id, c, []);
    }
    case 'stop': {
      const id = jobArg();
      if (typeof id !== 'string') return id;
      return outcomeSaid(await stopJob(p, id), verb, g);
    }
    case 'fetch': {
      const bad = want(2, '<job> <path inside its folder> [--to <local file>]');
      if (bad) return bad;
      if (!REMOTE_JOB_ID.test(pos[0])) return usage(`${JSON.stringify(pos[0])} is not a remote job id (r and 8 hex digits)`, json);
      const to = flags.get('--to');
      const r = await fetchFile(p, pos[0], pos[1], { ...(typeof to === 'string' ? { to } : {}), ...(c.cwd ? { cwd: c.cwd } : {}) });
      const lines: Line[] = [r.ok ? okLine(g, r.words) : failLine(g, r.words)];
      if (r.failure?.ssh) lines.push([label('    ssh: '), { text: r.failure.ssh.split('\n').slice(-3).join(' / ') }]);
      const { job, failure, ...rest } = r;
      return { code: r.ok ? 0 : 1, lines, json: { verb, ...rest, ...(job ? { job: jobView(job) } : {}), ...(failure ? { failure: { outcome: failure.outcome, words: failure.words } } : {}) } };
    }
    case 'tailnet': {
      const r = await readTailnet();
      const lines: Line[] = [r.ok ? [label('  '), { text: r.words }] : failLine(g, r.words)];
      for (const peer of r.peers) lines.push([{ text: `  ${peer.self ? '(this computer) ' : ''}${peer.name}`, role: 'strong' }, label(`  ${peer.dns_name ?? ''}  ${peer.addresses.join(' ')}  ${peer.os ?? ''}  ${peer.online === null ? '' : peer.online ? 'online' : 'offline'}`)]);
      return { code: r.ok ? 0 : 1, lines, json: { ok: r.ok, verb, words: r.words, peers: r.peers } };
    }
    default:
      return usage(`unknown verb ${JSON.stringify(verb)}`, json);
  }
}

/** A wait, said: Ctrl-C stops only the local ssh (exit 130), with the command that stops the job. */
async function waited(p: ConnectPaths, id: string, c: ConnectContext, before: Line[]): Promise<Said> {
  const g = c.glyphs;
  c.progress?.([label('  waiting for '), { text: id, role: 'strong' }, label(' to end (Ctrl-C stops only the waiting, not the job)')]);
  const r = await waitJob(p, id, { ...(c.signal ? { signal: c.signal } : {}), onRunning: (at) => c.progress?.([label(`  ${g.bullet} still running on the device at ${when(at)}`)]) });
  if ('error' in r) return { code: 1, lines: [...before, failLine(g, r.error)], json: { ok: false, verb: 'wait', error: r.error } };
  const said = outcomeSaid(r, 'wait', g);
  if (r.end === 'interrupted') {
    return { code: 130, lines: [...before, [{ text: `  ${g.warn} `, role: 'estimate' }, { text: r.words }], [label('    '), cmd(`timmy connect stop ${id}`)]], json: { ...said.json, ok: false, end: 'interrupted', words: r.words } };
  }
  // a wait exits 0 only when the job ended with exit 0 there; any other end (an exit, a stop, unknown) is 1
  const clean = r.end === 'ended' && r.job.state === 'ended' && r.job.remote?.exit_status === 0;
  return { ...said, code: clean ? 0 : 1, lines: [...before, ...said.lines], json: { ...said.json, ok: clean, end: r.end } };
}

/** The devices and jobs in brief, for `/connect` with nothing after it. */
export function connectSummary(c: ConnectContext): Line[] {
  const p = connectPaths(c.home);
  const devices = readDevices(p).devices;
  const jobs = listJobs(p);
  const lines: Line[] = [[label('  Timmy Connect: '), { text: `${devices.length} computer${devices.length === 1 ? '' : 's'}, ${jobs.length} remote job${jobs.length === 1 ? '' : 's'}` }, label(`  (records in ${shown(p.dir)}; default job folder ${DEFAULT_REMOTE_DIR})`)]];
  for (const d of devices.slice(0, 8)) lines.push([{ text: `  ${d.id}`, role: 'strong' }, label('  '), { text: deviceWords(d) }]);
  for (const j of jobs.slice(0, 8)) lines.push(...jobLines(jobView(j), c.glyphs));
  lines.push([label('  '), cmd('/connect help'), label(' lists the verbs')]);
  return lines;
}
