#!/usr/bin/env bash
# Offline end-to-end check: run a real dsh process against the fake Messages server with dsh-carryon installed,
# grow one headless session until automatic compaction folds it (the fake server scripts the Tracker and Compiler
# replies), make some folds fail on purpose, then check the session log with scripts/check-fold-log.mjs. No API key and no network beyond npm are needed.
#
# Usage: scripts/offline-check.sh
# Env:   DSH_BIN   dsh command to use (default: npx --yes @deepseek-ai/dsh@<engines.dsh pin>)
#        WORK      scratch directory (default: a new mktemp dir; holds DSH_HOME and the session cwd)
#        PORT      fake server port (default 8787)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_VERSION="0.2.2-alpha.2"
read -r -a DSH <<< "${DSH_BIN:-npx --yes @deepseek-ai/dsh@$DSH_VERSION}"
WORK="${WORK:-$(mktemp -d)}"
PORT="${PORT:-8787}"
PATCH="$ROOT/scripts/pressure.patch.yml"

export DSH_HOME="$WORK/home"
export DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT"
export DEEPSEEK_API_KEY="fake-key-for-the-offline-server"
mkdir -p "$DSH_HOME" "$WORK/repo"
echo "work dir: $WORK"

(cd "$ROOT" && pnpm -s build)

node "$ROOT/scripts/fake-messages-server.mjs" --port "$PORT" --reply-chars 12000 --log "$WORK/fake-requests.jsonl" &
FAKE_PID=$!
trap 'kill "$FAKE_PID" 2>/dev/null || true' EXIT
sleep 1

"${DSH[@]}" plugin --profile headless add "file:$ROOT" >/dev/null
"${DSH[@]}" --profile headless --dump-config > "$WORK/config.yml"
grep "name: dsh-carryon" "$WORK/config.yml" >/dev/null || { echo "dsh-carryon row missing" >&2; exit 1; }

cd "$WORK/repo"
turn() { "${DSH[@]}" --profile headless --patch "$PATCH" "$@"; }

# Overlays for the failure phases. A patch's config replaces the row's whole config, so each restates the keys.
overlay() {
  printf -- '- id: carryon-compaction\n  config:\n    thresholdRatio: 0.8\n    headroomTokens: 4000\n    retainTokens: 500\n    rescanTokens: 1500\n    fallbackRatio: %s\n' "$1" > "$WORK/$2"
}
overlay 1 strict.patch.yml       # a failed fold is never replaced by dsh's summary
overlay 0.5 fallback.patch.yml   # a failed fold is replaced by dsh's summary (context "near the window")

turn --json "Turn 1: describe the plan." > "$WORK/turn1.jsonl"
SID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").split("\n")[0]).sessionId)' "$WORK/turn1.jsonl")"
echo "session: $SID"
for i in 2 3 4 5 6; do turn --session-id "$SID" "Turn $i: continue with step $i." >/dev/null; done
for i in 7 8 9; do DSH_CARRYON_FAIL=1 turn --patch "$WORK/strict.patch.yml" --session-id "$SID" "Turn $i: continue with step $i." >/dev/null; done
for i in 10 11; do DSH_CARRYON_FAIL=1 turn --patch "$WORK/fallback.patch.yml" --session-id "$SID" "Turn $i: continue with step $i." >/dev/null; done
for i in 12 13 14 15; do turn --session-id "$SID" "Turn $i: continue with step $i." >/dev/null; done

LOG="$(ls "$DSH_HOME"/sessions/*/"$SID"/session.v*.jsonl.zstd | head -1)"
node "$ROOT/scripts/check-fold-log.mjs" "$LOG"
