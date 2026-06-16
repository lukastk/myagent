#!/bin/zsh
# Event-driven monitor for sesh worker subthreads.
#
# Usage: watch.sh <heartbeat_seconds> <thread_id> [thread_id ...]
#
# Polls each given sesh thread every 30s and EXITS as soon as ANY of them goes
# busy -> idle (its turn finished / it needs input), or after <heartbeat_seconds>
# (a fallback so the loop survives a hung/never-finishing worker). On exit it
# prints which workers are idle and a per-worker busy report.
#
# Run it via the harness's background mechanism (run_in_background: true) so you
# are re-invoked when it exits. Then handle the finished worker(s) and relaunch
# this for the still-running ids. Do NOT background it with a bare `&` — that
# won't re-invoke you on exit.
emulate -L zsh
heartbeat=${1:?usage: watch.sh <heartbeat_seconds> <id> [id ...]}; shift
ids=("$@")
[[ ${#ids} -gt 0 ]] || { print -r -- "no thread ids given"; exit 2 }
start=$EPOCHSECONDS
while true; do
  sleep 30
  idle=(); report=""
  for id in $ids; do
    busy=$(sesh thread status --id "$id" --json 2>/dev/null \
      | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("busy",""))
except Exception: print("?")')
    report+="$id busy=$busy"$'\n'
    [[ "$busy" != "busy" && "$busy" != "?" && -n "$busy" ]] && idle+=$id
  done
  if (( ${#idle} > 0 )); then
    print -r -- "EVENT=idle"
    print -r -- "IDLE_IDS=${(j: :)idle}"
    print -rn -- "$report"
    exit 0
  fi
  if (( EPOCHSECONDS - start >= heartbeat )); then
    print -r -- "EVENT=heartbeat"
    print -rn -- "$report"
    exit 0
  fi
done
