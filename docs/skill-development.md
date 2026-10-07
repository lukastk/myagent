# Skill authoring and distribution

On-demand reference extracted from the repository guide on 2026-10-07.
Paths in code spans are repository-root-relative unless explicitly qualified;
example paths and installed-home paths are not checkout files.
Dated incidents and validation results are historical observations, not a claim
about every currently installed runtime. Read only for the relevant task.

## How to write a new skill

### 1. Create a folder

```
skills/my-skill/SKILL.md
```

### 2. Add required frontmatter

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---
```

- `name` must be lowercase letters/numbers/hyphens and match the folder name.
- `description` should be specific so the agent knows when to load the skill.
- Add `disable-model-invocation: true` for manual or creative workflows the model rarely needs to auto-discover (7 local skills carry it, e.g. `deslop`, `html-slides`, `multipart-vault-doc`). It keeps the skill's name and description out of every turn's prompt in both Pi and Claude Code, while `/skill:name` (Pi) and `/name` (Claude Code) still invoke it. Leave it off skills that agents are told to use on their own (`gog`, `myvault`, `sesh-cli`, …).

### 3. Add instructions/scripts

A skill can include scripts and references, e.g.:

```
skills/my-skill/
├── SKILL.md
├── scripts/
│   └── run.sh
└── references/
    └── details.md
```

Use relative paths from `SKILL.md` when referring to local files.

### 4. Install and reload

Run:

```bash
./install.sh
```

Then reload Pi with `/reload` if it's running.

## Adding an external skill

Add a line to `external_skills.txt` (one per line):

```
vercel-labs/agent-skills@vercel-react-best-practices
```

Then run `./install.sh`.

This is also how the **skills that live in other mysetup repos** (`sesh-cli`,
`do-tickets`, `myvault`, `convo-review`, `boxyard-cli`, `mysetup-navigator`, …)
reach every harness: `external_skills.txt` lists them as `lukastk/<repo>@<skill>`.
`npx skills add` installs them from **GitHub as copies** (real directories under
`~/.agents/skills/`), not as symlinks to the local checkouts like the skills in
this repo. So an edit to e.g. `~/mysetup/sesh/skills/sesh-cli/SKILL.md` is not
live until it is pushed and `./install.sh` is re-run. To distribute a new one,
append `lukastk/<repo>@<skill>`.
