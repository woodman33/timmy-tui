/**
 * Round R4 (helper H78): God's Eye View's small map of the project: agents → the workflows and flows they ran in → the
 * files those runs made. It is an abstract layout, never geometry: a node's place says nothing of where anything is, and
 * the board labels it "layout, not geometry". Every edge is a link a record names (a flow record names its agent's run; a
 * run and a workflow run share an operation; a file is a run's output); nothing is inferred from names or times.
 */
import { MAP_LABEL, type AgentsSection, type AppsSection, type DevicesSection, type HostingSection, type MapNode, type OverviewMap, type WorkflowsSection } from './model.js';
import { dependencyColumns } from './remote.js';
import type { Sources } from './sources.js';
import { workflowRunOf } from './sections.js';

/** How many nodes each column draws; the rest are counted. */
export const MAP_MAX = { agents: 5, workflows: 5, artifacts: 6 } as const;

const cut = (s: string, n = 26): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * R4 (H93): with `devices` and `hosting`, two more columns drawn as a second band: remote jobs and orders, and what they
 * depend on (a remote job on its device, as its record names it; an order's step on a person's decision, as the backend
 * says it waits). Still a layout: a node's place says nothing of where a computer or a site is.
 */
export function buildMap(s: Sources, agents: AgentsSection, workflows: WorkflowsSection, apps: AppsSection, devices?: DevicesSection, hosting?: HostingSection): OverviewMap {
  const edges: OverviewMap['edges'] = [];
  const add = (from: string, to: string, why: string): void => { if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, why }); };
  // Agents: the code agent runs and the chat agent (its turns as one node).
  const agentRuns = agents.items.filter((i) => i.kind === 'agent');
  const chat = agents.items.filter((i) => i.kind === 'chat');
  const agentNodes: MapNode[] = agentRuns.map((a) => ({ id: `a:${a.id}`, label: cut(`${a.owner} ${a.id}`), kind: 'code agent', life: a.life, source: a.source }));
  if (chat.length) agentNodes.push({ id: 'a:chat', label: cut(`Timmy chat agent (${chat.length} turn${chat.length === 1 ? '' : 's'})`), kind: 'chat agent', life: 'ended', source: { record: null, command: '/room', board: 'room' } });
  // Workflows: the /iterate flows and the upmd documents.
  const flows = agents.items.filter((i) => i.kind === 'flow');
  const flowNodes: MapNode[] = flows.map((f) => ({ id: `w:${f.id}`, label: cut(`${f.owner.replace(/^Timmy flow /, '')} ${f.id}`), kind: 'flow', life: f.life, source: f.source }));
  const docNodes: MapNode[] = workflows.items.map((w) => ({ id: `w:${w.doc}`, label: cut(w.doc), kind: 'workflow document', ...(w.last_run ? { life: w.last_run.life } : {}), source: w.source }));
  // Artifacts: the files the runs made, editable first.
  const artifactNodes: MapNode[] = apps.artifacts.map((f) => ({ id: `f:${f.path}`, label: cut(f.path), kind: f.kind, source: f.source }));
  // Edges, each from a record: a flow's agent step names its run; a run in a workflow run's operation; a file a run made.
  for (const f of flows) {
    for (const h of f.handoffs) {
      const run = /\b(a[0-9a-f]{8})\b/.exec(h.state)?.[1];
      if (run && agentRuns.some((a) => a.id === run)) add(`a:${run}`, `w:${f.id}`, `flow ${f.id}'s record names agent run ${run} as its agent step`);
    }
  }
  for (const a of agentRuns) {
    const flow = a.handoffs.map((h) => /\b(f[0-9a-f]{8})\b/.exec(h.state)?.[1]).find((x): x is string => !!x);
    if (flow && flows.some((f) => f.id === flow)) add(`a:${a.id}`, `w:${flow}`, `agent run ${a.id} is the agent step of flow ${flow}`);
  }
  const jobs = s.jobs.ok ? s.jobs.value : [];
  for (const j of jobs) {
    if (j.kind !== 'workflow' || !j.operation) continue;
    const r = workflowRunOf(j);
    if (!r || !docNodes.some((d) => d.id === `w:${r.doc}`)) continue;
    for (const a of [...agentRuns, ...flows]) {
      if (a.operation !== j.operation) continue;
      add(`${a.kind === 'flow' ? 'w' : 'a'}:${a.id}`, `w:${r.doc}`, `${a.kind === 'flow' ? 'flow' : 'agent run'} ${a.id} and workflow run ${j.id} are both in operation ${j.operation}`);
    }
    if (chat.some((c) => c.operation === j.operation)) add('a:chat', `w:${r.doc}`, `a chat turn and workflow run ${j.id} are both in operation ${j.operation}`);
  }
  for (const f of apps.artifacts) {
    const flow = /\b(f[0-9a-f]{8})\b/.exec(f.by)?.[1];
    const agent = /\b(a[0-9a-f]{8})\b/.exec(f.by)?.[1];
    const doc = /^(.*) › \S+ \(run j[0-9a-f]{6}\)$/.exec(f.by)?.[1];
    if (flow) add(`w:${flow}`, `f:${f.path}`, `flow ${flow}'s record names ${f.path} (${f.role})`);
    else if (agent) add(`a:${agent}`, `f:${f.path}`, `agent run ${agent}'s record names ${f.path} (${f.role})`);
    else if (doc) add(`w:${doc}`, `f:${f.path}`, `a workflow run's sealed outcome names ${f.path}`);
  }
  const workflowNodes = [...flowNodes, ...docNodes];
  const columns: OverviewMap['columns'] = [
    { id: 'agents', title: 'Agents', nodes: agentNodes.slice(0, MAP_MAX.agents), more: Math.max(0, agentNodes.length - MAP_MAX.agents) },
    { id: 'workflows', title: 'Workflows and flows', nodes: workflowNodes.slice(0, MAP_MAX.workflows), more: Math.max(0, workflowNodes.length - MAP_MAX.workflows) },
    { id: 'artifacts', title: 'Files they made', nodes: artifactNodes.slice(0, MAP_MAX.artifacts), more: Math.max(0, artifactNodes.length - MAP_MAX.artifacts) },
  ];
  // R4 (H93): what remote jobs and orders depend on, as their records say
  if (devices && hosting) {
    const deps = dependencyColumns(devices, hosting);
    columns.push(...deps.columns);
    for (const e of deps.edges) add(e.from, e.to, e.why);
  }
  const drawn = new Set(columns.flatMap((c) => c.nodes.map((n) => n.id)));
  return {
    label: MAP_LABEL,
    words: 'An abstract layout of who made what and what waits on what: the agents, the workflows and flows they ran in, and the files those runs made; then the remote jobs and orders, and the computers and decisions they depend on. A position means nothing; each line is a link a record names.',
    columns,
    edges: edges.filter((e) => drawn.has(e.from) && drawn.has(e.to)),
  };
}
