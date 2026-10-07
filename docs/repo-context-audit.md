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
