# sesh orchestration mechanics

How to run the fan-out → verify → integrate loop with `sesh` (github.com/lukastk/sesh — the
multi-machine coding-agent layer). You run this from inside your own session; spawned workers
auto-parent to you. Full CLI: `sesh help`, `sesh thread --help`.

## 1. Spawn one worker per part

```bash
sesh thread new --agent claude --name <project>-<part> --cwd . --yolo --json \
  --msg "Read _dev/<work>/orchestration/SHARED.md then brief-<part>.md and execute it fully
and meticulously. Verify by rendering and looking. Report concisely (your final message is
the handoff). Do not git commit." \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'
```

- `--yolo` so the worker runs autonomously (writing files, running `uv`, rendering) without
  stalling on permission prompts. Appropriate for a sandboxed asset task.
- `--json` to capture the thread `id`. Record ids to `_dev/<work>/orchestration/worker-ids.tsv`.
- Auto-parenting: run inside a sesh thread (`$SESH_THREAD_ID`) and workers parent to you, so
  they show under you in `sesh thread grid` / the cockpit and the user can watch live.
- Spawn the independent workers of a wave together; hold dependent ones until their inputs land.

## 2. Monitor with an event-driven loop (don't fire-and-forget, don't blind-poll)

Use the bundled [`../scripts/watch.sh`](../scripts/watch.sh) as a **background** command
(`run_in_background: true`) so the harness re-invokes you when it exits:

```bash
zsh <skill>/scripts/watch.sh 900 <id1> <id2> <id3>
```

It polls `sesh thread status --id <id> --json` every 30s and exits the moment **any** worker
goes busy→idle (turn done / needs input), or after the heartbeat seconds (a fallback). On
re-invocation: handle the finished worker, then relaunch `watch.sh` for the still-running ids.
Pick a heartbeat ~900–1500s for big builds.

Other monitoring:
```bash
sesh thread grid --json | grep <project>          # all workers' head/busy at a glance
sesh thread status --id <id> --json               # one worker: busy / needs_input / pane
sesh tail <id> -n 40                              # transcript tail (raw jsonl)
sesh await <id> --timeout 20m                     # block until one turn completes
```

## 3. Read a worker's handoff report

The worker's final assistant message is the handoff. Pull it from the transcript jsonl (keyed
by the thread's `agent_session_id`):

```bash
asid=$(sesh thread info --id <id> --json | python3 -c 'import sys,json;print(json.load(sys.stdin).get("agent_session_id",""))')
f=$(find ~/.claude/projects -name "$asid.jsonl" 2>/dev/null | head -1)
python3 - "$f" <<'PY'
import json,sys
last=None
for line in open(sys.argv[1]):
    try: m=json.loads(line).get("message")
    except: continue
    if isinstance(m,dict) and m.get("role")=="assistant":
        for c in m.get("content",[]):
            if isinstance(c,dict) and c.get("type")=="text" and c.get("text","").strip(): last=c["text"]
print(last or "(none)")
PY
```

But the report is **not** the verification — render the asset and look (next step).

## 4. Verify by looking (the gate)

```bash
# SVG → PNG (substitute currentColor / var() with concrete colours, like the verify.py does):
uv run --with cairosvg --with pillow python - <<'PY'
import cairosvg, re
svg=open("asset.svg").read().replace("currentColor","#1C2024")
svg=re.sub(r'var\(--[\w-]+,\s*(#[0-9A-Fa-f]+)\)', r'\1', svg)
cairosvg.svg2png(bytestring=svg.encode(), write_to="/tmp/a.png", output_width=512, background_color="#F6F3EC")
PY
# HTML → PNG (real fonts + @font-face render truthfully; same-origin needed for iframe sizing):
uv run --with playwright python - <<'PY'
from playwright.sync_api import sync_playwright; import pathlib
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1280,"height":900})
    pg.goto(pathlib.Path("page.html").resolve().as_uri()); pg.wait_for_timeout(1500)
    pg.screenshot(path="/tmp/p.png", full_page=True); b.close()
PY
```

Then **Read** the PNG. Build a side-by-side/overlay against the reference with pillow when it
helps. Check at small + large sizes and on paper + ink.

## 5. Send a correction into the same thread (context preserved)

```bash
sesh thread send --id <id> --text "Verification found a defect: <precise description + the
proof that shows it>. Fix <file> so <criterion>, then re-render <proof> and confirm by looking.
Re-run the svelte autofixer. Report when re-verified."
```

Re-arm `watch.sh` on that id. This is why workers are long-lived threads, not one-shot
delegations — you iterate with their context intact.

## 6. Integrate & clean up

You own cross-boundary work: reconcile shared constants into one spec, assemble the
showcase/bible, prompt-style commit (workers committed nothing), deploy (`appgarden deploy` /
`apps redeploy`), update planning docs + memory. Then:

```bash
for id in <ids>; do sesh thread stop --id $id; done   # free resources; threads stay resumable
```

## Gotchas

- Launch the monitor via the harness's `run_in_background`, not a bare `&` — a detached `&`
  process won't re-invoke you on exit.
- `file://` blocks cross-frame access, so iframe auto-size scripts won't run in a local render;
  verify those on the deployed https site (render the live URL with Playwright).
- Strip `__pycache__` before committing (gitignore it).
- If a worker idles within seconds, check whether it finished or stalled/asked a question
  (`sesh thread status` `needs_input`) before assuming done.
