#!/usr/bin/env bash
# R5 lead (2026-10-15, the operator's completion order §6): builds the Timmy review package from this checkout. Nothing is
# published, tagged, deployed or installed globally: npm pack runs the same build a publish would (prepack), and the
# tarball stays in the package.
#
#   scripts/review/build-review.sh <out-dir>
#
# Makes <out-dir>/timmy-review-<rev>/ holding:
#   timmy-tui-<version>.tgz   the packed Timmy of this revision
#   timmy-app, Timmy App.command  R12: the Timmy app (browser) after the same first run; the .command is the double-click
#   timmy-review              the one launch command (R10, H163; scripts/review/timmy-review): first run installs and seeds,
#                             every run opens the Workbench; a name no one takes for the installed `timmy`
#   review.sh                 the launcher (scripts/review/review.sh): a sandbox beside itself, env -i, its own ports
#   census.mjs                what still runs in the sandbox (./review.sh census; R10, H163)
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

# R13 (the owner checkpoints packet, step 6): a reproducible install. The sandbox's dependency tree is resolved ONCE, here,
# into install-lock/package-lock.json (every package's version, its registry address and integrity hash), for the sandbox
# layout review.sh installs into (sandbox/prefix, the packed Timmy two folders up); review.sh then runs `npm ci` from it, so
# the Mac gets exactly that tree or a refusal, never a newer release published since. The node and npm that resolved it are
# recorded beside it.
lockdir="$out/lock-$rev"
rm -rf "$lockdir"; mkdir -p "$lockdir/sandbox/prefix"
cp "$pkg/$tgz" "$lockdir/$tgz"
printf '{\n  "name": "timmy-review-sandbox",\n  "private": true,\n  "dependencies": { "timmy-tui": "file:../../%s" }\n}\n' "$tgz" > "$lockdir/sandbox/prefix/package.json"
( cd "$lockdir/sandbox/prefix" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=error ) || { echo "build-review: resolving the install lock failed" >&2; exit 1; }
mkdir -p "$pkg/install-lock"
cp "$lockdir/sandbox/prefix/package.json" "$lockdir/sandbox/prefix/package-lock.json" "$pkg/install-lock/"
printf '{"node":"%s","npm":"%s","resolvedAt":"%s","packages":%s}\n' "$(node --version)" "$(npm --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(node -e 'const l=require(process.argv[1]);process.stdout.write(String(Object.keys(l.packages||{}).length-1))' "$pkg/install-lock/package-lock.json")" > "$pkg/install-lock/resolved-with.json"
echo "build-review: install lock: $(cat "$pkg/install-lock/resolved-with.json")"
rm -rf "$lockdir"

# R9 lead (after the R9 independent review, its F2): the README's branch is the checkout's, never a fixed round's ("|", not
# "/", as sed's delimiter: a branch name holds slashes)
branch=$(git branch --show-current 2>/dev/null); branch=${branch:-a detached revision}
fill() { sed -e "s/__REVFULL__/$revfull/g" -e "s/__REV__/$rev/g" -e "s/__TGZ__/$tgz/g" -e "s|__BRANCH__|$branch|g" "$1" > "$2"; }
fill scripts/review/review.sh "$pkg/review.sh"
fill scripts/review/timmy-review "$pkg/timmy-review"
fill scripts/review/README.md "$pkg/README.md"
# R12: ./timmy-app and its double-click twin (macOS) open the Timmy app after the same first run
cp scripts/review/timmy-app "$pkg/timmy-app"
cp "scripts/review/Timmy App.command" "$pkg/Timmy App.command"
chmod +x "$pkg/review.sh" "$pkg/timmy-review" "$pkg/timmy-app" "$pkg/Timmy App.command"
# R10 (H163): ./review.sh census counts what still runs in the sandbox, never itself or what it runs under
cp scripts/review/census.mjs "$pkg/census.mjs"
mkdir -p "$pkg/fake-lanes"
cp scripts/review/fake-lanes/* "$pkg/fake-lanes/"
chmod +x "$pkg"/fake-lanes/*

if [ -n "${UPMD_BIN:-}" ]; then
  mkdir -p "$pkg/bin"
  cp "$UPMD_BIN" "$pkg/bin/upmd" && chmod +x "$pkg/bin/upmd"
  if [ -n "${UPMD_LICENSE:-}" ]; then cp "$UPMD_LICENSE" "$pkg/bin/upmd-LICENSE.txt"; fi
fi
if [ -n "${EXTRA_DIR:-}" ]; then cp -R "$EXTRA_DIR"/. "$pkg/"; fi
# R13: the owners' mini-apps, each from its owner's source at an exact revision: <APP>_GIT=<repo> <APP>_REV=<commit> (its
# tracked files only: git archive, no node_modules, data, venvs or untracked files), or for an app with no commit (Timmy
# Animate) <APP>_DIR=<folder> <APP>_LABEL=<what the owner's archive is called>. Each gets a .timmy-source.json naming its
# source; an app with no committed lockfile gets one resolved here (install-lock), so review.sh can npm ci it too.
add_app_git() { # <id> <repo> <rev> <owner> [<owner's commit, when the repo's is an import of it>]
  local id=$1 repo=$2 r ownerrev=${5:-}
  r=$(git -C "$repo" rev-parse "$3")
  mkdir -p "$pkg/apps"
  git -C "$repo" archive --format=tar --prefix="$id/" "$r" | tar -x -C "$pkg/apps"
  printf '{"app":"%s","revision":"%s","owner":"%s","from":"git archive"%s}\n' "$id" "${ownerrev:-$r}" "$4" "${ownerrev:+,\"imported_as\":\"$r\",\"tree\":\"$(git -C "$repo" rev-parse "$r^{tree}")\"}" > "$pkg/apps/$id/.timmy-source.json"
  echo "build-review: $id ${ownerrev:-$r} (git archive)"
}
add_app_dir() { # <id> <folder> <owner> <label>
  local id=$1
  mkdir -p "$pkg/apps/$id"
  tar -C "$2" --exclude=./node_modules --exclude=./dist --exclude=./verification --exclude='._*' -cf - . | tar -x -C "$pkg/apps/$id"
  printf '{"app":"%s","revision":null,"label":"%s","owner":"%s","from":"owner archive"}\n' "$id" "$4" "$3" > "$pkg/apps/$id/.timmy-source.json"
  echo "build-review: $id $4 (owner archive)"
}
lock_app() { # <id>: resolve a lockfile for an app that ships none (recorded as resolved here, not the owner's)
  local d="$pkg/apps/$1"
  [ -f "$d/package-lock.json" ] && return 0
  ( cd "$d" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=error ) || { echo "build-review: $1: resolving its lock failed" >&2; exit 1; }
  printf '{"lock":"resolved by the review package build, not committed by the owner","node":"%s","npm":"%s"}\n' "$(node --version)" "$(npm --version)" > "$d/.timmy-lock.json"
}
if [ -n "${MODEL_STUDIO_GIT:-}" ]; then add_app_git model-studio "$MODEL_STUDIO_GIT" "${MODEL_STUDIO_REV:-HEAD}" "Codex: timmy-new-1"; fi
if [ -n "${CARD_LAB_GIT:-}" ]; then add_app_git card-lab "$CARD_LAB_GIT" "${CARD_LAB_REV:-HEAD}" "Codex: Timmy Card Lab" "${CARD_LAB_OWNER_REV:-}"; fi
if [ -n "${FILM_ROOM_GIT:-}" ]; then add_app_git film-room "$FILM_ROOM_GIT" "${FILM_ROOM_REV:-HEAD}" "Codex: Analyze NFL footage with AI"; fi
if [ -n "${ANIMATE_DIR:-}" ]; then add_app_dir animate "$ANIMATE_DIR" "Codex: Assess a 2D animator mini app" "${ANIMATE_LABEL:-owner archive}"; lock_app animate; fi
if [ -n "${STREAM_DIR:-}" ]; then add_app_dir stream-studio "$STREAM_DIR" "Codex: Assess a 2D animator mini app" "${STREAM_LABEL:-owner content checkpoint}"; lock_app stream-studio; fi

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sums="$out/SHA256SUMS.$rev.tmp"
(cd "$pkg" && find . -type f | LC_ALL=C sort | sed 's#^\./##' | while IFS= read -r f; do sha "$f"; done) > "$sums"
mv "$sums" "$pkg/SHA256SUMS"
tar -C "$out" -czf "$out/timmy-review-$rev.tar.gz" "timmy-review-$rev"
(cd "$out" && sha "timmy-review-$rev.tar.gz" > "timmy-review-$rev.tar.gz.sha256")

echo "build-review: revision $rev"
echo "build-review: $(cat "$out/timmy-review-$rev.tar.gz.sha256")"
grep -E "  (timmy-tui-.*\.tgz|timmy-review|review\.sh|README\.md)$" "$pkg/SHA256SUMS"
