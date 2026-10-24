#!/bin/bash
# Standard screenshot set for critic review. Usage: tools/shots.sh [outdir] [seed]
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
SEED="${2:-7}"
mkdir -p "$OUT"
BASE="http://localhost:8017/index.html"

shot() { node tools/shot.js "$BASE?$1&seed=$SEED" "$OUT/$2" 90000 | grep -E '"ready"|"errors"' >/dev/null; echo "  $2"; }

shot "cam=stadium&t=2"    01-stadium-wide.png
shot "cam=broadcast&t=8"  02-broadcast-early.png
shot "cam=broadcast&t=25" 03-broadcast-goal.png
shot "cam=closeup&t=12"   04-closeup.png
shot "cam=closeup&t=26"   05-closeup-goal.png
shot "cam=goal&t=18"      06-behind-goal.png
shot "cam=replay&t=30"    07-replay.png
shot "cam=broadcast&t=52" 08-broadcast-late.png
shot "cam=closeup&t=41"   09-closeup-3.png
shot "cam=stadium&t=24"   10-stadium-goal.png
echo "done -> $OUT/"
