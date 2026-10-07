/**
 * Tool activity labels (playbook §17.5): one table gives each tool a past verb, a noun, its primary
 * argument and a risk class. Risk drives the color (read default, write yellow, exec red, network or
 * model violet per DESIGN.md §10 B4) and, later, approvals.
 */
export type Risk = 'read' | 'write' | 'exec' | 'network';

export interface StepLabel {
  verb: string;
  present: string;
  noun: string;
  arg: string;
  risk: Risk;
}

interface Row { verb: string; present: string; noun: string; keys: string[]; risk: Risk }

const ROWS: Array<[RegExp, Row]> = [
  [/^run_in_daytona_workspace$/, { verb: 'Ran', present: 'Running', noun: 'workspace command', keys: ['command'], risk: 'exec' }],
  [/^(shell|bash|exec|run_command|run_shell|terminal)$/, { verb: 'Ran', present: 'Running', noun: 'shell command', keys: ['command', 'cmd'], risk: 'exec' }],
  [/^(file_read|read_file|read|view_file)$/, { verb: 'Read', present: 'Reading', noun: 'file', keys: ['path', 'file'], risk: 'read' }],
  [/^(file_write|write_file|write|create_file)$/, { verb: 'Wrote', present: 'Writing', noun: 'file', keys: ['path', 'file'], risk: 'write' }],
  [/^(file_edit|edit_file|edit|apply_patch|str_replace)$/, { verb: 'Edited', present: 'Editing', noun: 'file', keys: ['path', 'file'], risk: 'write' }],
  [/^(glob|find_files)$/, { verb: 'Explored', present: 'Exploring', noun: 'pattern', keys: ['pattern'], risk: 'read' }],
  [/^(grep|search|search_files|ripgrep)$/, { verb: 'Searched', present: 'Searching', noun: 'pattern', keys: ['pattern', 'query'], risk: 'read' }],
  [/^(list_dir|ls|list_directory)$/, { verb: 'Listed', present: 'Listing', noun: 'directory', keys: ['path', 'dir'], risk: 'read' }],
  [/^(web_search|search_web)$/, { verb: 'Fetched', present: 'Fetching', noun: 'search', keys: ['query'], risk: 'network' }],
  [/^(web_fetch|fetch|http|http_request|fetch_url)$/, { verb: 'Fetched', present: 'Fetching', noun: 'page', keys: ['url'], risk: 'network' }],
  [/^(generate|generate_.*|render_.*|image_.*|video_.*|tts|speech_.*)$/, { verb: 'Generated', present: 'Generating', noun: 'artifact', keys: ['path', 'output', 'prompt'], risk: 'network' }],
];

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof args[k] === 'string' && args[k]) return args[k] as string;
  const any = Object.values(args).find((v) => typeof v === 'string' && v);
  return typeof any === 'string' ? any : '';
}

export function labelFor(tool: string, args: Record<string, unknown> = {}): StepLabel {
  const row = ROWS.find(([re]) => re.test(tool))?.[1];
  // Playbook §17.5: the tool name always prints beside the marker.
  if (!row) return { verb: tool, present: tool, noun: 'call', arg: firstString(args, []), risk: 'read' };
  return { verb: row.verb, present: row.present, noun: row.noun, arg: firstString(args, row.keys).replace(/\s+/g, ' ').trim(), risk: row.risk };
}

/** Playbook §17.5: consonant + y becomes ies; s, sh, ch, x add es; else add s. */
export function plural(noun: string, count: number): string {
  if (count === 1) return noun;
  const words = noun.split(' ');
  const last = words.pop() ?? '';
  const p = /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : /(s|sh|ch|x)$/.test(last) ? `${last}es` : `${last}s`;
  return [...words, p].join(' ');
}
