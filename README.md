# myagent

Personal [Pi coding agent](https://github.com/badlogic/pi-mono) extensions and configuration.

## Setup

```bash
# Install Pi globally
npm install -g @mariozechner/pi-coding-agent

# Install extensions
./install.sh
```

`install.sh` symlinks local extensions into `~/.pi/agent/extensions/` and installs external extensions listed in `external_extensions.txt`.

## Adding extensions

**Local extension:** Create a folder under `extensions/` with an `index.ts`, then run `./install.sh`.

**External extension:** Add a line to `external_extensions.txt`, then run `./install.sh`.

See [AGENTS.md](AGENTS.md) for the full extension API reference.
