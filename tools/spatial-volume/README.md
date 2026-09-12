# Timmy native OpenVDB fixture

This bounded implementation stores explicit spatial state in a real `.vdb` file, reads it back, reconstructs a mesh with native OpenVDB, and compares that mesh against an analytic fixture. It is a local experiment in the canonical Timmy repository. It does not certify a physical object, run image generation, assign a material, or write Timmy production receipts.

## Runtime from the prior native experiment

- OpenVDB **13.0.0**, conda-forge build `py312h6747998_3`, file format 225.
- Python **3.12.14**, NumPy **2.5.3**, micromamba **2.9.0**, macOS arm64.
- Dedicated environment: `.timmy/venv-openvdb`.
- Dedicated micromamba binary/cache: `.timmy/runtime-openvdb`.
- No shell initialization and no changes to existing Python, Houdini, Blender, house-study environments, `package.json`, or receipts.
- Exact platform-specific package lock: `tools/spatial-volume/environment-osx-arm64.lock.txt`.

This focused worktree retains the `grid10` package and the source producer. It does not include the prior installation record, parent fixture index, `grid40` package, or private runtime directories. The versions above describe the environment that produced the retained artifact, not an environment automatically installed in a fresh checkout.

The recorded package exports `import openvdb`, whereas older upstream examples use `import pyopenvdb`. Its API was inspected in the original experiment. `FloatGrid`, `BoolGrid`, NumPy transfer, transforms, and `convertToPolygons` were exercised.

To create an optional runtime from the repository root:

```sh
mkdir -p .timmy/runtime-openvdb
curl -fL https://micro.mamba.pm/api/micromamba/osx-arm64/latest -o .timmy/runtime-openvdb/micromamba.tar.bz2
tar -xjf .timmy/runtime-openvdb/micromamba.tar.bz2 -C .timmy/runtime-openvdb bin/micromamba
.timmy/runtime-openvdb/bin/micromamba create --no-rc -y -r .timmy/runtime-openvdb/root -p .timmy/venv-openvdb -f tools/spatial-volume/environment-osx-arm64.lock.txt
```

The explicit lock pins the macOS arm64 environment packages. The micromamba bootstrap URL is moving; this focused port does not retain an attestation for the downloaded bootstrap binary. Runtime installation does not imply activation in every shell or application.

## Run

From the repository root:

```sh
.timmy/venv-openvdb/bin/python tools/spatial-volume/build_fixture.py --out studio/spatial-volume-local-run
.timmy/venv-openvdb/bin/python -m unittest discover -s tools/spatial-volume -p 'test_fixture.py' -v
```

The bounded producer supports resolutions 10 and 40 only. The command above creates a separate optional local run, preserving retained evidence. Only `studio/spatial-volume-20260912/grid10` is included in this focused port. `grid40` can be generated with the optional producer; it is not a committed input to the context checkpoints. Other resolutions are rejected before generation. Ordinary inspection reads retained artifacts.

The visual evidence exporter has a separate dependency surface. After explicitly preparing a Python environment with the exporter's dependencies, run its focused test with that interpreter:

```sh
.timmy/venv-visual/bin/python -m unittest discover -s tools/spatial-volume -p 'test_export_context_evidence.py' -v
```

The visual environment is not included in the port. Do not discover every Python test in the OpenVDB environment: native fixture tests and visual exporter tests require different runtimes.

## Spatial meaning

Both fixtures cover `[-50,50]³ mm` in a right-handed Cartesian frame. The constructed body is an 80 mm cube centered at zero with a 12 mm radius cylindrical bore along Z. This is an analytic construction, not perception of an unknown real object.

- `grid10`: 1,000 cells, 10 mm edge length.
- `grid40`: 64,000 cells, 2.5 mm edge length.
- Cell locations are fixed by the grid transform. JSON `origin` is cell `(0,0,0)`'s minimum corner. OpenVDB index `(0,0,0)` maps to that cell's center.
- Fractions use deterministic 8×8×8 subcell midpoint sampling. XY/Z separability accelerates the same 512 samples per cell; this does not turn the estimate into an exact integral.
- `boundary_field_mm` uses `max(boxSdf, radius - hypot(x,y))`. It has the desired CSG sign and zero set, but it is **not** a globally exact signed distance field. It is deliberately not tagged as a reinitialized narrow-band level set.
- Material and physical density remain unknown. Fractional occupancy is neither optical opacity nor mass density.

The five native grids are `fill_fraction`, `boundary_field_mm`, `fill_known`, `material_known`, and `density_known`. A numeric background value is a storage rule, not a knowledge claim. In particular, known empty `(0,0,0)` and unknown outside-domain `(-1,0,0)` both yield fill `0`, but `fill_known` differs. Unknown material/density masks are false throughout. OpenVDB active/inactive topology is not itself used as the epistemic mask: known zero fill can be stored inactive.

JSON uses `timmy.spatial-volume/1` manifests and `timmy.spatial-volume.cells/1` arrays. Dense values are `x-fastest`, flat index `i + nx*(j + ny*k)`. Every `null` fractional fill would mean unknown; this constructed fixture samples all cells in its declared domain. Material and density default to `{ "status": "unknown" }`. No mass is inferred. A retained override or measurement could refine that state later.

## Reconstruction and evidence

The mesh is reconstructed from the native boundary grid after `.vdb` write/read, using `FloatGrid.convertToPolygons(isovalue=0, adaptivity=0)`. Quads are triangulated for the JSON/OBJ export and metrics. The fractional-fill grid and boundary-field grid are complementary; fill fractions alone cannot identify the arrangement of material within a cell.

Independent analytic volume: `80³ − π × 12² × 80 = 475,808.85263064556 mm³`.

| Result | 1,000 cells | 64,000 cells |
|---|---:|---:|
| Sampled fill volume | 476,500 mm³ | 475,843.75 mm³ |
| Fractional-volume relative error | 0.145257% | 0.007334% |
| Reconstructed mesh volume | 458,266.4363 mm³ | 474,539.0543 mm³ |
| Mesh-volume relative error | 3.686862% | 0.266872% |
| Mean sampled surface error | 0.797021 mm | 0.053196 mm |
| Maximum sampled surface error | 3.333332 mm | 0.833332 mm |
| Closed edge manifold / consistent orientation | yes / yes | yes / yes |
| Connected components / Euler characteristic / genus | 1 / 0 / 1 | 1 / 0 / 1 |

These are comparative results from the prior native experiment. The 1,000-cell source and evidence are retained here; the 64,000-cell column is historical context, not an additional retained checkpoint artifact in this port.

Surface errors are distances at mesh vertices and triangle centroids to independently computed distances from the exposed cube faces and finite bore wall. They are **sampled**, not a Hausdorff bound, and do not establish accuracy at every surface point. The topology checks validate two-face edge incidence, opposite edge orientation, and one connected cycle in every vertex link. Genus is reported only for a connected closed vertex-manifold surface with a nonnegative integral Euler-derived result. These checks establish one handle for this fixture; they do not guarantee topology on arbitrary inputs. More resolution improved these specific measurements, which is not a promise of monotonic improvement for every shape or sampling choice.

`roundtrip.json` records exact equality of all in-domain grid values, preservation of source metadata, background values, and transform conversions at the origin, each independent axis, the far diagonal, and a negative-X location. Transform comparisons use an absolute tolerance of 1e-12 mm with relative tolerance explicitly zero. OpenVDB adds file-level statistics while writing; those additions are permitted. Known-empty versus unknown-outside behavior is explicitly checked. `.vdb` serialization may include changing metadata, so a new execution can have a new byte digest even when all values and metrics agree.

Each manifest binds its cell, native, mesh, OBJ, and roundtrip artifacts by bytes and SHA256. The retained grid10 package includes a detached `manifest.sha256`, which binds its manifest without a circular hash. A new producer run also creates an index for its outputs; the prior experiment's parent index is not included here. These establish local content identity, not producer authentication or a signed Timmy receipt. Physical validation is unmeasured.

## Validation

Nine native tests cover:

1. Numeric zero versus unknown and independent material/density knowledge masks.
2. Asymmetric values, center transforms, reverse conversion, and x-fastest export order.
3. Rejection of NaN, infinity, out-of-range fractions, and invalid voxel sizes.
4. CSG signs and independent analytic boundary-distance examples.
5. Deterministic sampling and measured refinement for this fixture.
6. Native reconstruction topology, artifacts/digests, and honest evidence labels.
7. Two closed tetrahedra sharing one vertex: the invalid vertex link prevents any genus claim.
8. A Y/Z basis swap that preserves the origin/diagonal/negative-X probes is detected by independent axis probes.
9. Unsupported fixture resolutions are rejected explicitly.

## Sources

- [OpenVDB Python API](https://www.openvdb.org/documentation/doxygen/python.html): grid access, masks, transform, I/O and polygon conversion.
- [OpenVDB overview](https://www.openvdb.org/documentation/doxygen/overview.html): sparse topology and spatial transforms.
- [conda-forge OpenVDB package](https://anaconda.org/conda-forge/openvdb): macOS arm64 package distribution.
- [Micromamba installation](https://mamba.readthedocs.io/en/latest/installation/micromamba-installation.html): manual local binary installation.
