# Repository context audit — 2026-10-07

Ten sesh children, one per repository, trimmed automatically loaded project
instructions on pocket4. This is the repository pass, separate from the
[shared/global context work](agent-context.md). Skills, runtime code, global
configuration and the project-memory loader were outside this pass.

## Source-size results

Counts include each root `AGENTS.md`, present `AGENTS.local.md`, and `CLAUDE.md`
stub once. Private myagent memory stayed private and unchanged. These are source
inventories, not captured requests or provider billing; token estimates use
**Unicode characters / 4**, not bytes / 4 or a tokenizer. Harness wrappers, global
instructions, tool declarations and skill metadata are excluded.

| Repository | Before bytes | After bytes | Reduction | Est. tokens before → after | Reviewed HEAD |
|---|---:|---:|---:|---:|---|
| sesh | 334,271 | 9,823 | 97.1% | 82,863 → 2,445 | `fb8237e` |
| myrig | 233,573 | 9,162 | 96.1% | 58,041 → 2,287 | `37b28bb` |
| mysystem | 196,532 | 9,041 | 95.4% | 48,547 → 2,259 | `fe98c2b` |
| myagent | 48,054 | 8,347 | 82.6% | 11,906 → 2,086 | `d6638b2` |
| obako | 40,452 | 7,067 | 82.5% | 9,948 → 1,763 | `fcb287f` |
| myarch | 38,793 | 10,098 | 74.0% | 9,678 → 2,522 | `28f7de9` |
| subswitcher | 23,136 | 7,367 | 68.2% | 5,758 → 1,837 | `08b404e` |
| myassistant | 22,672 | 6,107 | 73.1% | 5,630 → 1,525 | `e4ddfd5` |
| boxyard | 17,313 | 7,361 | 57.5% | 4,315 → 1,839 | `cd4b73b` |
| mymonitor | 14,652 | 5,983 | 59.2% | 3,648 → 1,495 | `34f50b8` |

Across these ten **separate repositories**: **969,448 → 80,356 bytes**
(**91.7% smaller**), approximately **240,331 → 20,057 tokens**.
This aggregate is not a per-session saving: a normal session loads its relevant
repository, not all ten.

## Preservation and review

- Each core retains purpose/ownership, dangerous pitfalls, mandatory contracts,
  commands and a task-to-reference map. Detailed manuals use ordinary links,
  not eager imports or instructions to read everything at startup.
- Sesh and myarch local-memory archives contain their original text verbatim;
  their eager memory files are now active-trap digests. Historical deployment
  claims and diagnoses are explicitly historical, not current fleet state.
- The large myrig/mysystem guides were split into indexed topic references.
  Parent line-preservation checks found every original nonblank line in the
  new docs; the same holds for obako and myassistant. Other guides retain
  semantic constraints while correcting stale guidance or reorganizing wording.
- All ten Claude import stubs match their pre-trim content. Parent review caught
  subswitcher dropping its future local-memory import; follow-up `08b404e`
  restored it after `1a8590f`, without rewriting history.
- Parent review checked all ten new operating guides, changed-file scope, local
  Markdown path targets, whitespace, tracked archive equality, imports and
  before/after source sizes. All ten worktrees were clean at review. Children
  additionally checked anchors, source paths and retained contracts.
- No credentials, private notes, services, real syncs or runtime files changed.
  No deployment is implied by these commits; checkout and live-session uptake
  must be verified separately.

## Baselines and detailed locations

Paths below are relative to each repository. Baselines precede its child trim
commit (myrig/myagent baselines already include the separate global-stage work).

- **boxyard** — baseline `eeb13fd`; `docs/development-reference.md`, `docs/sync-invariants.md`.
- **myagent** — baseline `47bc21d`; `docs/{workspace-operations,installation-and-settings,extension-development,skill-development,mcp-and-browsers}.md`.
- **myarch** — baseline `7a91c74`; `docs/desktop-investigations.md` (topic index and verbatim archive).
- **myassistant** — baseline `21c4994`; `docs/{consolidation,creating-skills,setup-reference,vault-reference}.md`.
- **mymonitor** — baseline `c1c4e97`; `docs/{monitor-contract,report-design,development-deployment}.md`.
- **myrig** — baseline `5934860`; `docs/reference/README.md` and 22 topic references.
- **mysystem** — baseline `bf05810`; `docs/README.md` and ten `docs/reference/` topics.
- **obako** — baseline `19c9002`; `docs/README.md` and architecture/development/framework/node-runtime/obsidian-toolkit references.
- **sesh** — baseline `079f50a`; `_dev/ENGINEERING_INDEX.md`, `_dev/engineering-history-h91-h121.md`, `_dev/TESTING.md`, `_dev/OPERATIONS.md`.
- **subswitcher** — baseline `f242566`; `docs/agent-reference/{credential-lifecycle,usage-and-cycling,harnesses-and-testing,oauth-endpoints}.md`.

## Initial fleet uptake (2026-10-07; superseded by follow-up below)

GitHub recovered from its earlier push failures; all ten trims and the preceding
global-stage commits were pushed. Using the canonical fast-forward-only sync,
57 of 60 repo/machine checkouts now contain their reviewed trim (including local
pocket4). Dirty checkouts were skipped before calling sync—no stash, merge, reset
or cleanup was attempted:

- **macbook / myrig:** modified `home/^macbook^/.skhdrc`.
- **mymain / myrig:** modified `scripts/post/all.sh`.
- **mymain / obako:** untracked `node_modules/`.

Shared instruction/reference/Codex wiring passes `audit-context.py --installed`
on **pocket4, macstudio, ideapad and termux**. The latter three received home-only
installation (`install.sh <machine> --no-setup`); pocket4 was installed earlier.
macbook and mymain still need their myrig update/home install; their audit failures
are not waived. Myagent's MCP/extension checkout is updated everywhere.
Machine-private ignored memory was not changed and can make other machines'
eager totals larger than the pocket4 table above.

The actual SDK model-request/discovery/call test passes on **pocket4 (Pi 1.0.4)**
and **macbook, macstudio, mymain, ideapad (Pi 0.99.1)**. Fleet testing exposed a
wrong major-version assumption in the new test: both hosts put declarations in
the initial system message's `toolsAdded`, not 0.99.1's top-level `Context.tools`.
The test now asserts the observed shape directly; no production fallback was added.

**Termux remains a separate validation blocker:** Pi 0.99.1 / Node 26.4.0 cannot
load the web extension's `sharp` dependency on `android-arm64`. Repeating the load
with the pre-change extension tree from `4837f0b` and the same installed
dependencies reproduced the identical error. This is pre-existing, not a passing
test or a context-trim regression; dependency repair is outside this pass.

No services or existing agent sessions were restarted. Checkout/home installation
does not replace an already loaded prompt: reload Pi or restart Claude/Codex when
convenient. Source fast-forwards also picked up previously pending upstream commits
on older checkouts; no sibling application builds or service deployments were run.

## Follow-up: deployment, skills and measurement (2026-10-07)

The user approved finishing deployment, fixing Termux, trimming the largest
skills and measuring fresh context. The three previously blocked updates are
now complete: inspection proved the existing edits/cache did not overlap incoming
changes. Canonical fast-forward sync and home-only installation preserved tracked
file hashes, complete working/index diffs, status and persistent stash lists;
Obako's untracked `.vite` cache was also verified unchanged.
**All 60 original repo/machine trims are present; shared wiring passes on all six.**

### Four skill bodies reduced and distributed

| Skill | Before bytes | After bytes | Source commit |
|---|---:|---:|---|
| sesh-cli | 99,549 | 7,129 | `d31e47f` |
| myvault | 34,204 | 8,422 | `8a87ac2` |
| mysetup-navigator | 24,668 | 7,423 | `e02cebc` |
| boxyard-cli | 26,037 | 6,863 | `462ac4f` |

Total: **184,458 → 29,837 bytes (83.8% smaller)**. This saves context when
a skill is loaded, not startup catalogue space: original frontmatter and discovery
semantics are unchanged. Detailed content lives in bundled task-routed references.
All four commits were pushed, installed on all six machines with the declared
Skills CLI source/agent options, and their **complete installed trees** compared
by hash with source. Pi/Claude paths resolve to the shared installed copies;
other skill bodies and inventory are unchanged (macbook has 22, others 21).

### Termux fixed; publication currently blocked

`cc369ec` adds the normal installer's supported native Sharp build against Termux
libvips and patched Node headers, with compatible build dependencies and a real
image probe. Sharp itself and all pre-existing locked dependency entries are
unchanged; no tool/image fallback or runtime behavior change was introduced.
Parent independently reran seven installer tests, seven image tests, and the
existing real Pi exposure/discovery/call test on Termux successfully. Pocket4
passes too. See [web setup and validation](../extensions/web/README.md#termux--android-native-image-support).

GitHub is again rejecting myagent pushes with HTTP 500; the last verified remote
main is `0de9c3d`. The fix is committed locally and working on Termux, but Termux's
eight-file test overlay still matches `cc369ec` byte-for-byte and must not be
discarded. Publish the reviewed commit, reconcile those owned identical files
into the fast-forwarded checkout, and verify clean status. Other repositories'
skill deployments are already published and complete.

### Actual controlled SDK measurements

[Fresh-session context](fresh-session-context.md), implemented in `8f50cf0`,
documents the approved, explicitly limited profile and reproducible command.
The full operational extension set was not started: hooks, RPC and MCP have real
side effects. These are **not default-session totals or provider billing**.
Parent independently reproduced 88 fresh fake-provider requests on Pi 1.0.4.
Initial estimates are roughly 6,931 characters/4 in neutral cwd and 9,043–9,401
in the three measured repos. The catalogue remains unchanged; the captured
explicit sesh-cli load falls from 24,626.5 to 1,719 characters/4. All four skill
before/after measurements are in that report. Claude/Codex were not measured.
The measurement commit shares the pending myagent publication blocker.

No existing agent sessions were reloaded, and no production services restarted.
