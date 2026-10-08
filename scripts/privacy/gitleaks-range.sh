#!/usr/bin/env bash
# The secret scan of a branch's complete history (ORDER privacy-d5n9; the operator's 2026-10-07
# 20:14 order, part 3). gitleaks-action scanned only a pull request's first 30 commits.
#
#   scripts/privacy/gitleaks-range.sh controls OUT_DIR   the §12 controls; run them first
#   scripts/privacy/gitleaks-range.sh scan OUT_DIR       the scan itself
#
# scan: every commit reachable from HEAD_SHA and not from the base, through all parents (never
# --first-parent, so a commit that arrived through a merged side branch is scanned too, even when
# a later commit removed what it added), and each merge commit's own diff against its first parent
# (--diff-merges=first-parent, so what a merge's resolution introduced is scanned too). The base is
# the merge-base with origin/BASE_REF, for a pull request or a push to any branch but the default
# one; a push to the default branch scans BEFORE_SHA..HEAD_SHA. It writes
# OUT_DIR/gitleaks-evidence.json (the base, the head, the range, the number of commits, the
# scanner's version and the result) and, on GitHub, the run's summary. Exit 0 when the range is
# clean, 1 when it finds a leak or the scan fails.
#
# controls: the must-fail fixture outside its allowlisted path must trip gitleaks; a secret added
# and then removed on a merged side branch must be found, although a first-parent walk misses it;
# and a secret introduced by a merge commit itself must be found, although a walk without merge
# diffs misses it. Exit 0 when all three behave, 1 when the gate is broken.
#
# Environment: GITLEAKS (the binary; default gitleaks), EVENT (pull_request, push or local),
# BASE_REF (default: DEFAULT_BRANCH), HEAD_SHA (default HEAD), BEFORE_SHA and PUSH_REF (push only),
# DEFAULT_BRANCH (default main).
set -uo pipefail
usage='usage: gitleaks-range.sh controls|scan OUT_DIR'
mode=${1:?$usage}; out=${2:?$usage}
mkdir -p "$out" && out=$(cd "$out" && pwd)
gl=${GITLEAKS:-gitleaks}
root=$(git rev-parse --show-toplevel) || exit 2
version=$("$gl" version 2>/dev/null) || { echo "gitleaks is not installed ($gl)" >&2; exit 2; }
die() { echo "gitleaks-range: $*" >&2; exit 1; }
count() { node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Array.isArray(d)?d.length:-1)}catch{console.log(-1)}' "$1"; }
detect() { # detect REPORT SOURCE [gitleaks options...]: prints gitleaks' exit status
  # gitleaks reads .gitleaksignore from the directory it runs in, so it runs inside SOURCE.
  local report=$1 source=$2; shift 2
  (cd "$source" && "$gl" detect --source . --redact --exit-code 2 --no-banner --report-format json --report-path "$report" "$@" >"$report.log" 2>&1)
  echo $?
}
commit_all() { git -C "$1" add -A && git -C "$1" -c user.email=ci@example.com -c user.name=ci commit -qm "$2"; }

if [ "$mode" = controls ]; then
  fixture="$root/lanes/privacy/fixtures/must-fail.txt"
  [ -f "$fixture" ] || die "the must-fail fixture is missing"
  # 1. The planted secret: the fixture, at a path the configuration does not allow.
  p=$(mktemp -d)
  git -C "$p" init -q -b main && cp "$root/.gitleaks.toml" "$p/" && commit_all "$p" base
  mkdir -p "$p/planted" && cp "$fixture" "$p/planted/notes.txt" && commit_all "$p" planted
  planted_exit=$(detect "$out/control-planted.json" "$p" --log-opts "HEAD~1..HEAD")
  planted_n=$(count "$out/control-planted.json")
  # 2. A side branch: main B0; feature A; side S1 adds the fixture and S2 removes it; feature
  #    merges side (M). The merge's own diff carries nothing, so only a walk through every parent
  #    sees S1.
  s=$(mktemp -d)
  git -C "$s" init -q -b main && cp "$root/.gitleaks.toml" "$s/" && commit_all "$s" B0
  b0=$(git -C "$s" rev-parse HEAD)
  git -C "$s" checkout -q -b feature && echo clean > "$s/a.txt" && commit_all "$s" A
  git -C "$s" checkout -q -b side "$b0" && mkdir -p "$s/side" && cp "$fixture" "$s/side/notes.txt" && commit_all "$s" S1
  git -C "$s" rm -q "side/notes.txt" && git -C "$s" -c user.email=ci@example.com -c user.name=ci commit -qm S2
  git -C "$s" checkout -q feature && git -C "$s" -c user.email=ci@example.com -c user.name=ci merge -q --no-ff --no-edit side
  side_exit=$(detect "$out/control-side-range.json" "$s" --log-opts "--diff-merges=first-parent $b0..HEAD")
  side_n=$(count "$out/control-side-range.json")
  side_fp_exit=$(detect "$out/control-side-first-parent.json" "$s" --log-opts "--first-parent $b0..HEAD")
  # 3. A merge that introduces the fixture itself (an evil merge): only its own diff carries it.
  m=$(mktemp -d)
  git -C "$m" init -q -b main && cp "$root/.gitleaks.toml" "$m/" && commit_all "$m" B0
  m0=$(git -C "$m" rev-parse HEAD)
  git -C "$m" checkout -q -b feature && echo clean > "$m/a.txt" && commit_all "$m" A
  git -C "$m" checkout -q -b side "$m0" && echo side > "$m/s.txt" && commit_all "$m" S
  git -C "$m" checkout -q feature && git -C "$m" -c user.email=ci@example.com -c user.name=ci merge -q --no-ff --no-commit side >/dev/null 2>&1
  mkdir -p "$m/m" && cp "$fixture" "$m/m/notes.txt" && commit_all "$m" M
  merge_exit=$(detect "$out/control-merge-range.json" "$m" --log-opts "--diff-merges=first-parent $m0..HEAD")
  merge_n=$(count "$out/control-merge-range.json")
  merge_plain_exit=$(detect "$out/control-merge-plain.json" "$m" --log-opts "$m0..HEAD")
  ok=false
  [ "$planted_exit" = 2 ] && [ "$planted_n" -ge 1 ] && [ "$side_exit" = 2 ] && [ "$side_n" -ge 1 ] && [ "$side_fp_exit" = 0 ] \
    && [ "$merge_exit" = 2 ] && [ "$merge_n" -ge 1 ] && [ "$merge_plain_exit" = 0 ] && ok=true
  CONTROLS_OK=$ok PLANTED_EXIT=$planted_exit PLANTED_N=$planted_n SIDE_EXIT=$side_exit SIDE_N=$side_n SIDE_FP_EXIT=$side_fp_exit \
  MERGE_EXIT=$merge_exit MERGE_N=$merge_n MERGE_PLAIN_EXIT=$merge_plain_exit VERSION=$version node -e '
    const e = process.env, n = (k) => Number(e[k]);
    const r = { schema: 1, kind: "gitleaks-controls", at: new Date().toISOString(), scanner: { name: "gitleaks", version: e.VERSION },
      planted: { exit: n("PLANTED_EXIT"), findings: n("PLANTED_N"), expect: "exit 2 with at least one finding" },
      side_branch_removed: { this_scan: { exit: n("SIDE_EXIT"), findings: n("SIDE_N"), expect: "exit 2" },
        first_parent_walk: { exit: n("SIDE_FP_EXIT"), expect: "exit 0: it misses a secret added and removed on a merged branch" } },
      merge_introduced: { this_scan: { exit: n("MERGE_EXIT"), findings: n("MERGE_N"), expect: "exit 2" },
        walk_without_merge_diffs: { exit: n("MERGE_PLAIN_EXIT"), expect: "exit 0: it misses what a merge itself added" } },
      ok: e.CONTROLS_OK === "true" };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(r, null, 2) + "\n");
    console.log(JSON.stringify(r));' "$out/gitleaks-controls.json"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### gitleaks controls (§12)\n\n| control | expected | observed |\n|---|---|---|\n| planted secret outside its allowed path | exit 2 | exit %s, %s finding(s) |\n| secret added and removed on a merged branch | exit 2 (a first-parent walk: 0) | exit %s, %s finding(s) (first-parent walk: %s) |\n| secret added by a merge itself | exit 2 (without merge diffs: 0) | exit %s, %s finding(s) (without merge diffs: %s) |\n\n' \
      "$planted_exit" "$planted_n" "$side_exit" "$side_n" "$side_fp_exit" "$merge_exit" "$merge_n" "$merge_plain_exit" >> "$GITHUB_STEP_SUMMARY"
  fi
  [ "$ok" = true ] || die "THE GATE IS BROKEN: a control did not behave (see $out/gitleaks-controls.json)"
  exit 0
fi

[ "$mode" = scan ] || die "$usage"
event=${EVENT:-local}; default=${DEFAULT_BRANCH:-main}; base_ref=${BASE_REF:-$default}
head=$(git -C "$root" rev-parse --verify -q "${HEAD_SHA:-HEAD}^{commit}") || die "the head ${HEAD_SHA:-HEAD} is not a commit here"
if [ "$event" = push ] && [ "${PUSH_REF:-}" = "refs/heads/$default" ]; then
  before=${BEFORE_SHA:-}
  if [ -n "$before" ] && [ "$before" != 0000000000000000000000000000000000000000 ] && git -C "$root" merge-base --is-ancestor "$before" "$head" 2>/dev/null; then
    base=$before; how="a push to $default: the pushed commits"
  else
    base=$(git -C "$root" rev-parse -q --verify "$head^" || true); how="a push to $default without a usable before: the head commit"
  fi
else
  git -C "$root" rev-parse --verify -q "origin/$base_ref^{commit}" >/dev/null || die "origin/$base_ref is missing (check out the full history)"
  base=$(git -C "$root" merge-base "origin/$base_ref" "$head") || die "no merge-base between origin/$base_ref and $head"
  how="the merge-base with origin/$base_ref"
fi
range=${base:+$base..}$head
commits=$(git -C "$root" rev-list --count "$range"); merges=$(git -C "$root" rev-list --count --merges "$range")
first_parent=$(git -C "$root" rev-list --count --first-parent "$range")
# gitleaks runs in a worktree checked out at the head, so the configuration and the ignore list it
# reads are the head's own, whatever this checkout holds (a pull request's is its merge with the base).
wt=$(mktemp -d) && rmdir "$wt" && git -C "$root" worktree add -q --detach "$wt" "$head" || die "could not check out $head"
trap 'git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1' EXIT
history_exit=$(detect "$out/history.json" "$wt" --log-opts "--diff-merges=first-parent $range")
history_n=$(count "$out/history.json")
blob_sha() { git -C "$root" cat-file -e "$head:$1" 2>/dev/null && git -C "$root" show "$head:$1" | sha256sum | cut -d' ' -f1 || echo none; }
EVENT_=$event BASE_REF_=$base_ref BASE_=${base:-none} HEAD_=$head RANGE_=$range HOW_=$how COMMITS_=$commits MERGES_=$merges FP_=$first_parent \
HX_=$history_exit HN_=$history_n VERSION_=$version CONFIG_=$(blob_sha .gitleaks.toml) IGNORE_=$(blob_sha .gitleaksignore) \
IGNORE_N_=$(git -C "$root" show "$head:.gitleaksignore" 2>/dev/null | grep -cv '^\s*\(#\|$\)') node -e '
  const e = process.env, n = (k) => Number(e[k]);
  const r = { schema: 1, kind: "gitleaks-scan", at: new Date().toISOString(), event: e.EVENT_, base_ref: e.BASE_REF_,
    base: e.BASE_, head: e.HEAD_, range: e.RANGE_, base_rule: e.HOW_, commits: n("COMMITS_"), merges: n("MERGES_"),
    first_parent_commits: n("FP_"), traversal: "every parent, plus the diff of each merge against its first parent (--diff-merges=first-parent)",
    scanner: { name: "gitleaks", version: e.VERSION_, config_sha256: e.CONFIG_, ignore_sha256: e.IGNORE_, ignore_entries: n("IGNORE_N_") },
    history: { exit: n("HX_"), findings: n("HN_") }, ok: e.HX_ === "0" };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(r, null, 2) + "\n");
  console.log(JSON.stringify(r));' "$out/gitleaks-evidence.json"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### gitleaks: the complete range\n\n| | |\n|---|---|\n| event | %s |\n| base | `%s` (%s) |\n| head | `%s` |\n| range | `%s` |\n| commits | %s (%s merges; a first-parent walk would see %s) |\n| scanner | gitleaks %s |\n| result | exit %s, %s finding(s) |\n\n' \
    "$event" "${base:-none}" "$how" "$head" "$range" "$commits" "$merges" "$first_parent" "$version" "$history_exit" "$history_n" >> "$GITHUB_STEP_SUMMARY"
fi
[ "$history_exit" = 0 ] || die "the scan of $range found leaks or failed (exit $history_exit; see $out/history.json)"
exit 0
