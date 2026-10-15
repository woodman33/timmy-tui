#!/usr/bin/env bash
# R5 lead (2026-10-15, the operator's completion order §6): builds the installable review bundle from this checkout.
# Nothing is published, tagged, deployed or installed globally: npm pack runs the same build a publish would (prepack),
# and the tarball stays in the bundle.
#
#   scripts/review/build-review.sh <out-dir>
#
# Makes <out-dir>/timmy-review-<rev>/ holding the npm tarball, launch.sh, stop.sh, REVIEW.md and SHA256SUMS, then
# <out-dir>/timmy-review-<rev>.tar.gz with its .sha256 beside it. Refuses a checkout with uncommitted tracked changes, so
# the revision it names is the code it packed.
set -euo pipefail

out=${1:?usage: scripts/review/build-review.sh <out-dir>}
root=$(git rev-parse --show-toplevel)
cd "$root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "build-review: refusing: the checkout has uncommitted tracked changes; commit them first" >&2
  exit 2
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "build-review: Node 24 or newer is needed (found $(node --version))" >&2
  exit 2
fi

rev=$(git rev-parse --short=12 HEAD)
mkdir -p "$out"
out=$(cd "$out" && pwd)
bundle="$out/timmy-review-$rev"
rm -rf "$bundle"
mkdir -p "$bundle"

echo "build-review: packing $rev (npm pack runs the build) ..."
npm pack --pack-destination "$bundle" --json > "$out/pack-$rev.json"
tgz=$(cd "$bundle" && ls timmy-tui-*.tgz)

for f in launch.sh stop.sh REVIEW.md; do
  sed -e "s/__REV__/$rev/g" -e "s/__TGZ__/$tgz/g" "scripts/review/$f" > "$bundle/$f"
done
chmod +x "$bundle/launch.sh" "$bundle/stop.sh"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd "$bundle" && sha "$tgz" launch.sh stop.sh REVIEW.md > SHA256SUMS)
tar -C "$out" -czf "$out/timmy-review-$rev.tar.gz" "timmy-review-$rev"
(cd "$out" && sha "timmy-review-$rev.tar.gz" > "timmy-review-$rev.tar.gz.sha256")

echo "build-review: revision $rev"
echo "build-review: $(cat "$out/timmy-review-$rev.tar.gz.sha256")"
(cd "$bundle" && cat SHA256SUMS)
