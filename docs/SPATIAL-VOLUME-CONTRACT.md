# Bounded spatial volumes, version 1

Timmy gives every location in a finite grid an address. A known address does not imply known fill, appearance, material, or density. The read-only implementation is `src/vision/spatial/volume.ts`; local file inspection is `src/vision/spatial/volume-cli.ts`.

## Inspect an exported package

```sh
timmy vision spatial volume inspect studio/spatial-volume-20260912/grid10/manifest.json
timmy vision spatial volume inspect studio/spatial-volume-20260912/grid10/manifest.json --cell 5,5,5 --json
```

The command verifies local artifact byte lengths and SHA-256 digests, then validates a dense cell field. It never runs a model, launches OpenVDB, contacts a provider, assigns material, or writes a production receipt. A matching VDB file proves local byte identity; this command does not parse its native contents or authenticate its producer. The fixture producer's native round-trip report is a separate artifact. Unknown or corrupt inputs produce a failure, rather than an apparently empty region.

This focused port includes the grid10 package. The native producer can optionally create grid40 in a separate local output directory after its runtime is installed; that larger package is not a committed input to this port. See `tools/spatial-volume/README.md` for the pinned environment and separate native/visual test commands.

## Manifest

One manifest describes one resolution. A separate index can connect coarse and fine representations. Extra construction metadata may accompany the manifest; the inspector computes its own coverage and filled-volume estimate from admitted cell data.

```json
{
  "schema": "timmy.spatial-volume/1",
  "id": "analytic-box-bore-10",
  "grid": {
    "frameId": "fixture", "units": "mm",
    "origin": [-50, -50, -50],
    "basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    "dimensions": [10, 10, 10], "cellSize": [10, 10, 10]
  },
  "fill": {"status": "sampled", "method": "regular-subcell-centers", "samplesPerAxis": 8},
  "material": {"status": "unknown"},
  "density": {"status": "unknown"},
  "boundary": {"representation": "csg-implicit", "exactDistance": false, "description": "CSG sign field; not an exact distance everywhere"},
  "artifacts": {"cells": {"path": "cells.json", "sha256": "REPLACE_WITH_ACTUAL_64_CHARACTER_SHA256", "bytes": 1234}}
}
```

The hash and byte length above are placeholders, not usable evidence. Native, mesh, OBJ, and round-trip artifacts may additionally appear under `native`, `mesh`, `obj`, and `roundtrip`, each using the same descriptor. Every declared artifact is checked; paths cannot escape the manifest directory, including through symlinks.

`origin` is the minimum corner of cell `[0,0,0]` in the declared grid basis, not its center. Basis vectors are columns and must form a right-handed orthonormal frame. Grid dimensions are positive integers; cell sizes are positive in `mm`, `cm`, or `m`. Version 1 admits at most one million cells. Half-open index bounds are `0 ≤ i < nx`, `0 ≤ j < ny`, `0 ≤ k < nz`. Locations outside that domain are unknown to this package, even when a native sparse grid supplies an implicit background value there.

The world-space center is `origin + basis × ((ijk + 0.5) × cellSize)`. For rotated grids the origin need not be the minimum world-axis-aligned point. The flat index is `i + nx × (j + ny × k)`.

Version 1 rejects grids whose world-coordinate precision cannot reliably distinguish their cell spacing. A conservative rounding-error bound covers the whole region and projects uncertainty onto each grid axis, including rotated frames. For example, one-unit cells translated to an origin of `1e20` cannot be represented distinctly with JavaScript numbers. Use a nearby local frame or larger cells. Positive cell and region volumes must remain finite and nonzero in both declared cubic units and cubic metres; a positive fill fraction that underflows to zero volume is also rejected.

## Dense cells with independent unknown states

```json
{
  "schema": "timmy.spatial-volume.cells/1",
  "order": "x-fastest",
  "fractions": [0, 0.5, null, 1],
  "overrides": [
    {"ijk": [1,0,0], "material": {"status": "declared", "id": "polymer-reference-12", "source": "operator assignment"}}
  ]
}
```

This four-cell illustration requires a matching four-cell grid. `0` means sampled or declared empty; `1` means full by the stated method; a fraction lies between them; `null` means unknown. The array must contain exactly one entry for every address. Missing entries, sparse-array holes, duplicates, nonfinite values and fractions outside `[0,1]` are rejected. Partial fill gives an occupied-volume estimate; it does not locate the material within a cell and does not establish its optical opacity.

An optional `boundaryField` array has matching length, uses the grid's distance units, and has `null` for unknown samples. Its manifest declaration names the representation. A CSG implicit field must use `exactDistance: false`: Boolean combinations may preserve sign and the zero surface while ceasing to be exact distance everywhere. The sampled field does not remove finite-resolution error.

Manifest material and density states are defaults. Per-cell `overrides` change either independently. A cell can have one override object containing either or both properties. Version 1 admits:

- Material: `{status:"unknown"}` or `{status:"declared"|"measured", id, source}`.
- Density: `{status:"unknown"}` or `{status:"declared"|"measured", value, unit:"kg/m3", basis:"occupied-material", source}`.

Unknown properties must not carry hidden values. Known density is the intrinsic density of the occupied material, not a bulk-cell density already multiplied by fill. For a single-material cell, estimated mass would be `fill fraction × cell volume in m³ × intrinsic density`. This version does not calculate mass, mix materials, infer interior density from texture, or treat the source's `measured` label as authenticated measurement evidence.

Optional references use `{id,kind:"shape"|"appearance"|"material",uri}`. They are suggestions only. A copper-looking image does not assign copper or its density. A reference never changes fill or property coverage automatically, and the inspector never fetches its URI. Accepting a material hypothesis would require a separate explicit assignment and provenance record.

## Shared projection and implementation boundaries

Browser or TUI consumers use the same pure functions:

1. `validateVolumeManifest(unknown)` admits the manifest and strips unrelated metadata.
2. `validateVolumeCells(unknown, manifest)` admits complete bounded coverage.
3. `inspectVolume(manifest, cells, optionalAddress)` computes coverage and optional cell detail.
4. `formatVolumeReport(report)` formats the same report for a terminal.

`lookupVolumeCell` exposes the address, center, fill state, material state, density state, and optional boundary sample. Consumers must pass validated manifest and cell values. Pure projections report byte verification as `not-checked`. The local package reader sets it to `sha256-bytes-checked` only after checking all declared artifacts. Neither path claims native parsing, authenticated producer identity, or physical validation.

The report separates accounted filled volume from unknown capacity. Its complete estimate is `null` while any fill is unknown. Even a complete sampled estimate remains approximate. Material and density coverage count the whole bounded region, including empty cells; their unknown states do not make geometric coverage incomplete.

This is an additive spatial data contract. It preserves Timmy's existing OpenRouter provider, agent execution, and append-only receipt writer paths. Future adapters can connect stable object and feature identities to these volumes. Future multi-material or probabilistic occupancy models should use an explicit schema extension rather than reinterpret fill fraction as confidence or opacity.
