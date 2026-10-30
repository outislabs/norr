#!/bin/bash
# Run the equity minimum map at fixed UTC times and append the output to docs/research/.
# Usage: scripts/research/run-at.sh "2026-10-30T22:00:00Z" "2026-10-31T14:00:00Z" ...
# Started with nohup so it survives the terminal; it dies if the machine sleeps or is switched off.
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
for T in "$@"; do
  target=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$T" +%s)
  now=$(date -u +%s)
  [ "$target" -gt "$now" ] && sleep $((target - now))
  out="docs/research/min-map-$(date -u +%Y%m%dT%H%MZ).txt"
  {
    echo "# scheduled for $T"
    python3 scripts/research/equity-min-map.py --venue both --side buy --tickers NVDAon,TSLAon,AAPLon,QQQon,SPYon,MSFTon,INTCon,HOODon --sizes 5,5.05,5.25,6,10,20,25,26,30
    python3 scripts/research/equity-min-map.py --venue confidential --side sell --tickers NVDAon,TSLAon,MSFTon --sizes 4,5,5.25,6,10,26
  } > "$out" 2>&1
  echo "wrote $out"
done
