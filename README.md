# myagent

Personal [Pi coding agent](https://github.com/badlogic/pi-mono) extensions, skills, and configuration.

## Setup

```bash
# Install Pi globally
npm install -g @earendil-works/pi-coding-agent

# Install local + external extensions and skills
./install.sh

# Also remove extensions/skills that are no longer declared
./install.sh --prune
```

`install.sh` does all of the following:

- Symlinks local extensions from `extensions/` into `~/.pi/agent/extensions/`
- Symlinks local skills from `skills/` into `~/.agents/skills/`
- Installs external extensions listed in `external_extensions.txt` via `pi install`
- Installs external skills listed in `external_skills.txt` via `npx skills add <source> -g -y`
- With `--prune`, removes stale local symlinks and uninstalls previously managed external entries that are no longer listed

## Adding extensions

- **Local extension:** create `extensions/<name>/index.ts`, then run `./install.sh`.
- **External extension:** add a line to `external_extensions.txt`, then run `./install.sh`.

## Adding skills

- **Local skill:** create `skills/<name>/SKILL.md`, then run `./install.sh`.
- **External skill:** add a line to `external_skills.txt`, then run `./install.sh`.

For full details and examples, see [AGENTS.md](AGENTS.md).
