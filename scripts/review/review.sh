#!/usr/bin/env bash
# Timmy review package (R4 lead's launcher, carried into R5 by the R5 lead): the packed Timmy of one exact revision, run in
# a home of its own beside this script. Nothing is installed globally. Timmy writes only under the sandbox folder (and in a
# project you point it at). Linux and macOS, bash 3.2 or later. Start with:  ./review.sh help
# scripts/review/build-review.sh fills in the revision and the package's name.
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REV="__REV__"
TGZ="$HERE/__TGZ__"
BOX="${TIMMY_REVIEW_HOME:-$HERE/sandbox}"
PREFIX="$BOX/prefix"
H="$BOX/home"
WORK="$H/work"
# R5: 4440-4442, apart from an earlier review's 4430-4432 that may still be open on the same computer
STUDIO_PORT="${TIMMY_STUDIO_PORT:-4440}"
LOGS_PORT="${TIMMY_LOGS_PORT:-4441}"
COMPANION_PORT="${TIMMY_COMPANION_PORT:-4442}"

say() { printf '%s\n' "$*"; }
die() { printf 'review.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# R5 lead (the Mac walk at aa247e5): the node Timmy runs on is the one ./review.sh install used, recorded here, never just the
# first on the caller's PATH. There a tmux pane's shell startup files put an older node first, and the Workbench ran on
# Node 22 although ./review.sh where, in the terminal that installed it, named Node 24.
NODE_FILE="$BOX/node.path"
node_dir() { [ -f "$NODE_FILE" ] && dirname "$(cat "$NODE_FILE")"; }

# the review's PATH: the installed timmy first, then the FAKE lane stand-ins (so no real lane program can start), then the
# folder of the node install used, then upmd 0.2.7 from bin/ on Linux x86_64 when this computer has no upmd of its own, then
# this computer's PATH (a timmy or a lane program in the node's folder still comes after the two before it)
review_path() {
  local p="$PREFIX/node_modules/.bin:$HERE/fake-lanes" d
  d="$(node_dir)"
  [ -n "$d" ] && p="$p:$d"
  if ! command -v upmd >/dev/null 2>&1 && [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] && [ -x "$HERE/bin/upmd" ]; then
    p="$p:$HERE/bin"
  fi
  printf '%s:%s' "$p" "$PATH"
}

# the node the review runs Timmy on: the one install recorded, still there and still Node 24 or later
need_node() {
  local n v
  n="$(cat "$NODE_FILE" 2>/dev/null)"
  { [ -n "$n" ] && [ -x "$n" ]; } || die "the node ./review.sh install used is not recorded, or is no longer there ($NODE_FILE): run ./review.sh install again, with Node 24 or later first on PATH" 3
  v="$("$n" -p 'process.versions.node' 2>/dev/null)"
  [ "${v%%.*}" -ge 24 ] 2>/dev/null || die "$n is Node ${v:-of an unknown version}, older than the package asks (Node 24 or later): run ./review.sh install again, with Node 24 first on PATH" 3
}

# runs "$@" in the review's environment: its own HOME, Timmy home, settings, tmux and temporary folders, its ports, no
# model key from your shell (a key reaches Timmy only if you give it to `./review.sh timmy init` yourself). From your shell,
# only these pass when you set them: TIMMY_CHAT_FREE_ONLY, TIMMY_PALETTE, TIMMY_CLEF (decision-model routing, for this
# process) and TIMMY_RERUN (the rerun program Timmy reads recordings with), and TZ
run() {
  mkdir -p "$H" "$WORK" "$BOX/tmp" "$BOX/tmux" "$BOX/mcp-home/.mcporter"
  [ -f "$BOX/mcp-home/.mcporter/mcporter.json" ] || printf '{"mcpServers": {}}\n' > "$BOX/mcp-home/.mcporter/mcporter.json"
  env -i \
    PATH="$(review_path)" HOME="$H" USER="${USER:-review}" LOGNAME="${LOGNAME:-review}" SHELL="${SHELL:-/bin/bash}" \
    TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-}" LANG="${LANG:-C.UTF-8}" LC_ALL="${LC_ALL:-}" \
    TMPDIR="$BOX/tmp" TMUX_TMPDIR="$BOX/tmux" \
    TIMMY_HOME="$H/timmy" TIMMY_SETTINGS_DIR="$BOX/settings" TIMMY_MCP_HOME="$BOX/mcp-home" \
    TIMMY_STUDIO_PORT="$STUDIO_PORT" TIMMY_LOGS_PORT="$LOGS_PORT" TIMMY_COMPANION_PORT="$COMPANION_PORT" TIMMY_LOGS_OPEN=0 \
    TIMMY_REVIEW="$REV" FAKE_LANES_LOG="$BOX/fake-lanes.log" ${TIMMY_CHAT_FREE_ONLY:+TIMMY_CHAT_FREE_ONLY="$TIMMY_CHAT_FREE_ONLY"} \
    ${TIMMY_PALETTE:+TIMMY_PALETTE="$TIMMY_PALETTE"} \
    ${TIMMY_CLEF:+TIMMY_CLEF="$TIMMY_CLEF"} ${TIMMY_RERUN:+TIMMY_RERUN="$TIMMY_RERUN"} \
    ${TZ:+TZ="$TZ"} \
    "$@"
}

# the active project's folder, as Timmy records it (<Timmy home>/state/active-project.json), when it is still there
active_root() {
  node -e 'try { const fs = require("fs"); const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).root; if (typeof r === "string" && fs.statSync(r).isDirectory()) process.stdout.write(r); } catch {}' "$H/timmy/state/active-project.json" 2>/dev/null
}

# where a command starts: the folder you are in when it is inside the review's home (a project of the review), else the
# active project's folder (so `./review.sh timmy receipts` reads that project's receipts), else the work folder
start_dir() {
  case "$(pwd -P)/" in "$H"/*) pwd -P; return ;; esac
  local a
  a="$(active_root)"
  if [ -n "$a" ]; then printf '%s' "$a"; else printf '%s' "$WORK"; fi
}

need_install() { [ -x "$PREFIX/node_modules/.bin/timmy" ] || die "not installed yet: run ./review.sh install first" 2; need_node; }

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  help|-h|--help)
    cat <<HELP
Timmy review package, revision $REV

  ./review.sh install        install the packed Timmy into $BOX/prefix (Node 24 or later; npm fetches its dependencies)
  ./review.sh demo           a new Timmy home with three projects: "first-light" (timmy init's own), "blank", then "tray"
                             (from the tray-workflow starter), the active project at the end, with scripted review content:
                             a VoxVision observation of the package's example image and a report run that writes four files
  ./review.sh workbench      the terminal Workbench, the main space: keys 1-9 and 0 are the ten tabs, c shows the browser
                             companion, s shows Studio, ? lists every key (on the active project; p switches)
  ./review.sh check          the shared workspace frame, after asking each service once with a free request
                             (timmy workspace check: OpenRouter's key endpoint, your Ollama, Studio, the companion)
  ./review.sh repl           the REPL (plain timmy), on the active project
  ./review.sh watch          the full-screen monitor
  ./review.sh ollama HOST MODEL   chat on your own Ollama (no key, no charge): HOST like 127.0.0.1:11434, MODEL one it lists
  ./review.sh timmy ARGS...  any timmy command (for example: timmy op <id> --project <folder>, timmy receipts, timmy tools)
  ./review.sh shell          a shell in the review's environment (type timmy ... yourself; exit to leave)
  ./review.sh where          the folders and ports this review uses
  ./review.sh clean          remove the sandbox ($BOX), only that

Ports (127.0.0.1 only): Studio $STUDIO_PORT, the log companion $LOGS_PORT, the browser companion $COMPANION_PORT
(set TIMMY_STUDIO_PORT, TIMMY_LOGS_PORT or TIMMY_COMPANION_PORT before a command to change them).
HELP
    ;;
  install)
    command -v node >/dev/null 2>&1 || die "node is not on PATH: the package needs Node 24 or later" 3
    [ "$(node_major)" -ge 24 ] || die "node $(node --version) is older than the package asks (Node 24 or later)" 3
    command -v npm >/dev/null 2>&1 || die "npm is not on PATH" 3
    [ -f "$TGZ" ] || die "the package file is missing: $TGZ" 3
    mkdir -p "$PREFIX"
    say "Installing $(basename "$TGZ") into $PREFIX (npm fetches its dependencies; --ignore-scripts: no install script runs)..."
    npm install --prefix "$PREFIX" --no-audit --no-fund --ignore-scripts --loglevel=error "$TGZ" || die "npm install failed (above)" 1
    # the node itself (its real file, not a version manager's shim): every later command runs Timmy on it
    node -p 'process.execPath' > "$NODE_FILE" || die "could not record the node in use ($NODE_FILE)" 1
    say "Timmy runs on $(cat "$NODE_FILE") ($(node --version)) in every ./review.sh command, whatever node a shell puts first."
    run timmy --version
    ;;
  demo)
    need_install
    ( cd "$WORK" 2>/dev/null || { mkdir -p "$WORK" && cd "$WORK"; }
      run timmy init --yes && \
      run timmy act '/project new blank' && \
      run timmy act '/project new tray --from tray-workflow' ) || die "the demo setup stopped (above)" 1
    # R6 (H143, H144): demo content in tray, so its previews show records Timmy made, not empty boxes: the package's example
    # image as a reference with a VoxVision observation of it (tab 5), and a workflow run that writes four files and a log
    # (tab 3, and the companion's run detail). Scripted review content, said so in each file; a step this computer cannot do
    # says why and the demo goes on.
    TRAY="$H/timmy/projects/tray"
    EX="$PREFIX/node_modules/timmy-tui/examples/visual-tools/preview.png"
    if [ -f "$EX" ] && [ -d "$TRAY" ]; then
      say ""
      say "Demo content (scripted, for the review) in tray: a reference image, its VoxVision observation, a report run"
      ( cd "$TRAY" && run timmy act "/add $EX" --project "$TRAY" ) && \
        { ( cd "$TRAY" && run timmy act '/detect refs/preview.png color 255,255,255' --wait --project "$TRAY" ) || \
          say "VoxVision: Look needs setup on this computer (above); tab 5 shows that record as it is"; }
      mkdir -p "$TRAY/refs" && cp "$EX" "$TRAY/refs/demo-preview.png" && \
        printf '%s\n' '# Report (review demo)' '' '```bash [name:report]' 'mkdir -p out' \
          "printf '# Report\\n\\nWritten by the review demo run.\\n' > out/report.md" 'cp recipes/tray.params.json out/tray.params.json' \
          "printf '{\"demo\":\"review\",\"ok\":true}\\n' > out/summary.json" 'cp refs/demo-preview.png out/preview.png' \
          'for i in $(seq 1 60); do echo "demo line $i"; done' '```' > "$TRAY/REPORT.md" && \
        { ( cd "$TRAY" && run timmy act '/run REPORT.md report' --wait --project "$TRAY" ) || \
          say "The report run did not finish (above; a workflow needs upmd: ./review.sh where names it): tab 3 shows the run as it is"; }
    else
      say "The package's example image is not in this install ($EX): the demo content (VoxVision, the report run) was skipped"
    fi
    # R7 (H153): a generated demo mesh in tray, for tab 6's mesh view (Timmy's own STL reader measures it; it is not a
    # native export, and its file's header says so). R8 lead (H154): the same tray as OBJ and PLY too, made by the same
    # script from the STL's own triangles, so tab 6 lists the three kinds its readers take (each file's first comment says
    # it is generated)
    MESHES="$PREFIX/node_modules/timmy-tui/examples/visual-tools"
    if [ -f "$MESHES/demo-tray.stl" ] && [ -d "$TRAY" ]; then
      mkdir -p "$TRAY/refs"
      got=""
      for kind in stl obj ply; do
        [ -f "$MESHES/demo-tray.$kind" ] && cp "$MESHES/demo-tray.$kind" "$TRAY/refs/demo-tray.$kind" && got="$got refs/demo-tray.$kind"
      done
      say "Generated demo meshes in tray:$got (tab 6 lists and draws them)"
      # R9 lead: the same tray as a generated Rerun recording (scripts/demo-recording.py), so tab 6 lists a recording and
      # reads its entities and time range through the installed Rerun CLI, or says why it cannot
      if [ -f "$MESHES/demo-tray.rrd" ]; then
        cp "$MESHES/demo-tray.rrd" "$TRAY/refs/demo-tray.rrd"
        say "Generated demo recording in tray: refs/demo-tray.rrd (tab 6 reads it through the Rerun CLI where one is installed)"
      fi
    else
      say "The package's demo mesh is not in this install ($MESHES/demo-tray.stl): tab 6 has no mesh to draw"
    fi
    say ""
    say "Ready: ./review.sh workbench (tray, the active project now), or ./review.sh repl"
    ;;
  ollama)
    need_install
    [ $# -eq 2 ] || die "usage: ./review.sh ollama HOST MODEL   (HOST like 127.0.0.1:11434; MODEL one your Ollama lists)" 2
    ( cd "$WORK" && run timmy init --yes --chat local --ollama "$1" --model "$2" )
    ;;
  check)
    need_install
    ( cd "$(start_dir)" && run timmy workspace check "$@" )
    ;;
  workbench|repl|watch)
    need_install
    DIR="$(start_dir)"
    if [ "$cmd" = repl ]; then ( cd "$DIR" && run timmy "$@" ); else ( cd "$DIR" && run timmy "$cmd" "$@" ); fi
    ;;
  timmy)
    need_install
    ( cd "$(start_dir)" && run timmy "$@" )
    ;;
  shell)
    need_install
    say "A shell in the review's environment (Timmy $REV). Type timmy ...; exit to leave."
    ( cd "$(start_dir)" && run bash --norc --noprofile -i )
    ;;
  where)
    say "revision      $REV"
    say "package       $TGZ"
    say "sandbox       $BOX"
    say "install       $PREFIX"
    say "home          $H (Timmy home: $H/timmy)"
    say "work folder   $WORK"
    say "active        $(active_root || true)"
    say "ports         Studio $STUDIO_PORT, log companion $LOGS_PORT, browser companion $COMPANION_PORT (127.0.0.1)"
    say "free-only     ${TIMMY_CHAT_FREE_ONLY:-the setting in the sandbox (off unless you turned it on: ./review.sh timmy act '/model free-only on')}"
    say "upmd          $(PATH="$(review_path)" command -v upmd || echo 'not found: workflows say how to install it')"
    if [ -f "$NODE_FILE" ]; then
      say "node          $(cat "$NODE_FILE") $("$(cat "$NODE_FILE")" --version 2>/dev/null || echo '(no longer there: ./review.sh install again)') (the one install used; Timmy runs on it)"
    else
      say "node          not recorded yet (./review.sh install records the node it used)"
    fi
    say "shell's node  $(command -v node || echo 'not found') $(node --version 2>/dev/null) (first on this shell's PATH; not the one Timmy runs on when they differ)"
    ;;
  clean)
    case "$BOX" in /|"$HOME"|"") die "refusing to remove $BOX" 2 ;; esac
    [ -d "$BOX" ] || { say "nothing to remove: $BOX is not there"; exit 0; }
    printf 'Remove %s and everything in it? Type yes: ' "$BOX"
    read -r answer
    [ "$answer" = yes ] || { say "kept"; exit 0; }
    rm -r -- "$BOX" && say "removed $BOX"
    ;;
  *)
    die "unknown command: $cmd (./review.sh help)" 2
    ;;
esac
