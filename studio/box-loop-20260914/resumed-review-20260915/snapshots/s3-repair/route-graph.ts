export interface RouteEdge {
  id: string;
  from: string;
  to: string;
  backendId: string;
  qualification: { status: string; eligible: boolean; evidence: string[]; [key: string]: unknown };
  dependencies: string[];
  preservedProperties: string[];
  losses: Record<string, unknown>;
  [key: string]: unknown;
}
export interface RouteGraph {
  schema: string;
  scope: string;
  sourceProperties: string[];
  edges: RouteEdge[];
  [key: string]: unknown;
}
export interface RouteRequest { from: string; to: string; requiredProperties: string[]; independent: number }
export interface PlannedRoute {
  edgeIds: string[];
  backendIds: string[];
  losses: { edgeId: string; losses: Record<string, unknown> }[];
}
export interface UnavailableRouteEdge {
  edgeId: string;
  reason: string;
  qualificationStatus: string;
  dependencies: string[];
  missingProperties: string[];
}
export interface RoutePlan {
  status: 'planned' | 'refused';
  reason: string;
  paths: PlannedRoute[];
  unavailable: UnavailableRouteEdge[];
}

const MAX_EDGES = 128;
const MAX_NODES = 64;
const MAX_STATES = 8192;
const MAX_PATHS = 2048;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const word = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const words = (value: unknown): value is string[] => Array.isArray(value) && value.every(word);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Plans declared, qualified routes only; does not run adapters or authenticate evidence.
 * Dependencies describe qualification gates; their resolution belongs to the descriptor producer.
 * Required properties must already be known at the source and survive every edge.
 */
export function planRoute(graph: RouteGraph, request: RouteRequest): RoutePlan {
  const unavailable: UnavailableRouteEdge[] = [];
  const refuse = (reason: string): RoutePlan => ({ status: 'refused', reason, paths: [], unavailable });
  const planned = (paths: PlannedRoute[]): RoutePlan => ({ status: 'planned', reason: 'qualified_paths', paths, unavailable });
  if (!record(request) || !word(request.from) || !word(request.to) || !words(request.requiredProperties)
    || ![1, 2].includes(request.independent)) return refuse('invalid_request');
  if (!record(graph) || !word(graph.schema) || !word(graph.scope) || !words(graph.sourceProperties)
    || !Array.isArray(graph.edges) || graph.edges.length > MAX_EDGES) return refuse('invalid_graph');
  const nodes = new Set<string>(), ids = new Set<string>();
  for (const edge of graph.edges) {
    if (!record(edge) || !word(edge.id) || !word(edge.from) || !word(edge.to) || !word(edge.backendId)
      || ids.has(edge.id) || !words(edge.dependencies) || !words(edge.preservedProperties)) return refuse('invalid_graph');
    ids.add(edge.id); nodes.add(edge.from); nodes.add(edge.to);
  }
  if (nodes.size > MAX_NODES) return refuse('invalid_graph');
  const required = [...new Set(request.requiredProperties)].sort(compare);
  const missingSource = required.filter(property => !graph.sourceProperties.includes(property));
  const allowed: RouteEdge[] = [];
  for (const edge of [...graph.edges].sort((a, b) => compare(a.id, b.id))) {
    const qualification = edge.qualification;
    const missingProperties = required.filter(property => !edge.preservedProperties.includes(property));
    const reason = !record(qualification) || !word(qualification.status) || qualification.eligible !== true
      ? 'not_qualified'
      : !words(qualification.evidence) || qualification.evidence.length === 0
        ? 'missing_evidence'
        : !Object.hasOwn(edge, 'losses') || !record(edge.losses)
          ? 'undeclared_losses'
          : missingProperties.length ? 'required_properties_lost' : null;
    if (reason) unavailable.push({ edgeId: edge.id, reason, qualificationStatus: record(qualification) && word(qualification.status) ? qualification.status : 'unknown', dependencies: [...edge.dependencies], missingProperties });
    else allowed.push(edge);
  }
  if (missingSource.length) return refuse('source_properties_unavailable');
  if (request.from === request.to) return refuse('identical_endpoints');
  const adjacency = new Map<string, RouteEdge[]>();
  for (const edge of allowed) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  type State = { node: string; visited: Set<string>; edges: RouteEdge[] };
  const queue: State[] = [{ node: request.from, visited: new Set([request.from]), edges: [] }];
  const paths: PlannedRoute[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const state = queue[cursor];
    for (const edge of adjacency.get(state.node) ?? []) {
      // A cycle cannot manufacture a missing property or a second route.
      if (state.visited.has(edge.to)) continue;
      const edges = [...state.edges, edge];
      if (edge.to === request.to) {
        const path: PlannedRoute = {
          edgeIds: edges.map(item => item.id),
          backendIds: [...new Set(edges.map(item => item.backendId))].sort(compare),
          losses: edges.map(item => ({ edgeId: item.id, losses: { ...item.losses } })),
        };
        if (request.independent === 1) return planned([path]);
        if (paths.length >= MAX_PATHS) return refuse('search_limit');
        paths.push(path);
      } else {
        if (queue.length >= MAX_STATES) return refuse('search_limit');
        queue.push({ node: edge.to, visited: new Set([...state.visited, edge.to]), edges });
      }
    }
  }
  if (paths.length === 0) return refuse('no_qualified_path');
  // BFS and sorted edge IDs provide deterministic length/ID ordering.
  // Search pairs, rather than greedily committing to a path that blocks both alternatives.
  let best: [PlannedRoute, PlannedRoute] | undefined;
  let bestLength = Infinity;
  for (let i = 0; i < paths.length; i++) {
    const backends = new Set(paths[i].backendIds);
    for (let j = i + 1; j < paths.length; j++) {
      const length = paths[i].edgeIds.length + paths[j].edgeIds.length;
      if (length >= bestLength || paths[j].backendIds.some(backend => backends.has(backend))) continue;
      best = [paths[i], paths[j]]; bestLength = length;
    }
  }
  return best ? planned(best) : refuse('insufficient_independent_backends');
}
