#!/usr/bin/env bash
# R5 lead (2026-10-15, the operator's completion order §6): builds the Timmy review package from this checkout. Nothing is
# published, tagged, deployed or installed globally: npm pack runs the same build a publish would (prepack), and the
# tarball stays in the package.
#
#   scripts/review/build-review.sh <out-dir>
#
# Makes <out-dir>/timmy-review-<rev>/ holding:
#   timmy-tui-<version>.tgz   the packed Timmy of this revision
#   review.sh                 the launcher (scripts/review/review.sh): a sandbox beside itself, env -i, its own ports
#   fake-lanes/               FAKE stand-ins for the lane programs, so a review never starts a real lane
#   bin/upmd, its licence     only when UPMD_BIN (and UPMD_LICENSE) name them: upmd for Linux x86_64 (workflows)
#   README.md                 scripts/review/README.md with this revision filled in
#   anything in EXTRA_DIR     when set: the rehearsal's notes and captures, copied as they are
#   SHA256SUMS                every file above
# then <out-dir>/timmy-review-<rev>.tar.gz with its .sha256 beside it. Refuses a checkout with uncommitted tracked changes,
# so the revision it names is the code it packed.
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

rev=$(git rev-parse --short=7 HEAD)
mkdir -p "$out"
out=$(cd "$out" && pwd)
pkg="$out/timmy-review-$rev"
rm -rf "$pkg"
mkdir -p "$pkg"

echo "build-review: packing $rev (npm pack runs the build) ..."
npm pack --pack-destination "$pkg" --json > "$out/pack-$rev.json"
tgz=$(cd "$pkg" && ls timmy-tui-*.tgz)

fill() { sed -e "s/__REV__/$rev/g" -e "s/__TGZ__/$tgz/g" "$1" > "$2"; }
fill scripts/review/review.sh "$pkg/review.sh"
fill scripts/review/README.md "$pkg/README.md"
chmod +x "$pkg/review.sh"
mkdir -p "$pkg/fake-lanes"
cp scripts/review/fake-lanes/* "$pkg/fake-lanes/"
chmod +x "$pkg"/fake-lanes/*

if [ -n "${UPMD_BIN:-}" ]; then
  mkdir -p "$pkg/bin"
  cp "$UPMD_BIN" "$pkg/bin/upmd" && chmod +x "$pkg/bin/upmd"
  if [ -n "${UPMD_LICENSE:-}" ]; then cp "$UPMD_LICENSE" "$pkg/bin/upmd-LICENSE.txt"; fi
fi
if [ -n "${EXTRA_DIR:-}" ]; then cp -R "$EXTRA_DIR"/. "$pkg/"; fi

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sums="$out/SHA256SUMS.$rev.tmp"
(cd "$pkg" && find . -type f | LC_ALL=C sort | sed 's#^\./##' | while IFS= read -r f; do sha "$f"; done) > "$sums"
mv "$sums" "$pkg/SHA256SUMS"
tar -C "$out" -czf "$out/timmy-review-$rev.tar.gz" "timmy-review-$rev"
(cd "$out" && sha "timmy-review-$rev.tar.gz" > "timmy-review-$rev.tar.gz.sha256")

echo "build-review: revision $rev"
echo "build-review: $(cat "$out/timmy-review-$rev.tar.gz.sha256")"
grep -E "  (timmy-tui-.*\.tgz|review\.sh|README\.md)$" "$pkg/SHA256SUMS"
