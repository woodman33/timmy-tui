#!/usr/bin/env bash
# R5 lead (2026-10-15, the operator's completion order §6): builds the Timmy review package from this checkout. Nothing is
# published, tagged, deployed or installed globally: npm pack runs the same build a publish would (prepack), and the
# tarball stays in the package.
#
#   scripts/review/build-review.sh <out-dir>
#
# Makes <out-dir>/timmy-review-<rev>/ holding:
#   timmy-tui-<version>.tgz   the packed Timmy of this revision
#   timmy-review              the one launch command (R10, H163; scripts/review/timmy-review): first run installs and seeds,
#                             every run opens the Workbench; a name no one takes for the installed `timmy`
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
revfull=$(git rev-parse HEAD)
mkdir -p "$out"
out=$(cd "$out" && pwd)
pkg="$out/timmy-review-$rev"
rm -rf "$pkg"
mkdir -p "$pkg"

echo "build-review: packing $rev (npm pack runs the build) ..."
# R10 (H163): the packed build carries the revision it was built from: TIMMY_BUILD_REVISION makes the build's
# scripts/generate-version.ts write dist/build-info.json for this HEAD (it refuses any other), which `timmy --version` and the
# Workbench's About read (src/build-info.ts). The checkout's own copy of the stamp is removed afterwards, whatever happens, so
# a later build or a plain tsc there never carries this revision's stamp
trap 'rm -f "$root/dist/build-info.json"' EXIT
TIMMY_BUILD_REVISION="$revfull" npm pack --pack-destination "$pkg" --json > "$out/pack-$rev.json"
tgz=$(cd "$pkg" && ls timmy-tui-*.tgz)
stamped=$(tar -xzOf "$pkg/$tgz" package/dist/build-info.json 2>/dev/null | node -e 'let t = ""; process.stdin.on("data", (d) => { t += d; }).on("end", () => { try { const s = JSON.parse(t); process.stdout.write(`${s.revision} ${s.dirty}`); } catch { process.stdout.write("none"); } })') || stamped="none"
if [ "$stamped" != "$revfull false" ]; then
  echo "build-review: the packed build's stamp says \"$stamped\", not revision $revfull from a clean checkout: refusing to ship it" >&2
  exit 1
fi
echo "build-review: the packed build carries its revision ($rev, dist/build-info.json)"

# R9 lead (after the R9 independent review, its F2): the README's branch is the checkout's, never a fixed round's ("|", not
# "/", as sed's delimiter: a branch name holds slashes)
branch=$(git branch --show-current 2>/dev/null); branch=${branch:-a detached revision}
fill() { sed -e "s/__REVFULL__/$revfull/g" -e "s/__REV__/$rev/g" -e "s/__TGZ__/$tgz/g" -e "s|__BRANCH__|$branch|g" "$1" > "$2"; }
fill scripts/review/review.sh "$pkg/review.sh"
fill scripts/review/timmy-review "$pkg/timmy-review"
fill scripts/review/README.md "$pkg/README.md"
chmod +x "$pkg/review.sh" "$pkg/timmy-review"
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
grep -E "  (timmy-tui-.*\.tgz|timmy-review|review\.sh|README\.md)$" "$pkg/SHA256SUMS"
