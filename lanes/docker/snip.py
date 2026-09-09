#!/usr/bin/env python3
# Deterministic, dependency-aware snip of the Docker Engine OpenAPI (ORDER
# captain-y9g4). apisnip is the named tool but its ratatui picker has no headless
# mode and would not drive reliably over a pty here (same finding as the wire
# order). This reproduces what apisnip does — trim the surface to a curated set
# of paths and transitively pull every $ref it needs — deterministically, so the
# curated spec is valid and a typed client can be generated from it.
#
#   snip.py <input.yaml> <output.yaml>
#
# Curated set: the endpoints Timmy's Docker-as-lanes surface needs — containers
# (list/create/start/stop/exec/wait/logs/remove), images (list/create/inspect),
# exec (start/inspect), system (version/info/ping). Everything else is dropped.
import sys, yaml

KEEP = [
    ('/containers/json', None), ('/containers/create', None),
    ('/containers/{id}/start', None), ('/containers/{id}/stop', None),
    ('/containers/{id}/wait', None), ('/containers/{id}/logs', None),
    ('/containers/{id}/exec', None), ('/containers/{id}', 'delete'),
    ('/containers/{id}/json', None), ('/containers/{id}/kill', None),
    ('/exec/{id}/start', None), ('/exec/{id}/json', None),
    ('/images/json', None), ('/images/create', None), ('/images/{name}/json', None),
    ('/version', None), ('/info', None), ('/_ping', None),
]

def refs_in(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == '$ref' and isinstance(v, str) and v.startswith('#/definitions/'):
                out.add(v.split('/')[-1])
            else:
                refs_in(v, out)
    elif isinstance(node, list):
        for v in node: refs_in(v, out)

def main():
    inp, outp = sys.argv[1], sys.argv[2]
    spec = yaml.safe_load(open(inp))
    all_paths = spec.get('paths', {})
    defs = spec.get('definitions', {})
    kept_paths = {}
    for p, only in KEEP:
        if p in all_paths:
            item = all_paths[p]
            kept_paths[p] = {only: item[only]} if only and only in item else item
    # transitive definition closure
    need = set(); refs_in(kept_paths, need)
    seen = set()
    while need - seen:
        n = (need - seen).pop(); seen.add(n)
        if n in defs:
            more = set(); refs_in(defs[n], more); need |= more
    kept_defs = {k: defs[k] for k in sorted(seen) if k in defs}
    out = {
        'swagger': spec.get('swagger', '2.0'),
        'info': {'title': 'Docker Engine API (Timmy curated snip)', 'version': spec.get('info', {}).get('version', 'v1.54'),
                 'description': 'Curated by lanes/docker/snip.py for the Timmy Docker lane: containers, images, exec, system. Source: docs.docker.com Engine API.'},
        'basePath': spec.get('basePath', '/v1.54'),
        'schemes': spec.get('schemes', ['http']),
        'paths': kept_paths,
        'definitions': kept_defs,
    }
    yaml.safe_dump(out, open(outp, 'w'), sort_keys=False, default_flow_style=False, width=100)
    print(f"paths {len(all_paths)} -> {len(kept_paths)}; definitions {len(defs)} -> {len(kept_defs)}; ops " +
          str(sum(len([m for m in v if m in ('get','post','delete','put')]) for v in kept_paths.values())))

if __name__ == '__main__':
    main()
