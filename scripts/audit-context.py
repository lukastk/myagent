#!/usr/bin/env python3
"""Read-only context inventory. Estimates are characters / 4, NOT billed tokens.

Run from any directory. --myrig selects a non-sibling checkout.
--installed also verifies the current home's shared instruction wiring.
Project/skill files are measured only; no budget or truncation is imposed on them.
"""
import argparse
import json
from pathlib import Path
import re


def measure(path):
    text = path.read_text()
    return {"bytes": len(text.encode()), "estimated_tokens_chars_div_4": round(len(text) / 4)}


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--myrig", type=Path, default=repo.parent / "myrig")
    parser.add_argument("--installed", action="store_true")
    args = parser.parse_args()
    core = args.myrig / "home/.pi/agent/AGENTS.md"
    mcp = json.loads((repo / "mcp.json").read_text())
    report = {
        "method": "UTF-8 bytes and characters/4; not provider token accounting",
        "shared_rules": {"path": str(core), **measure(core)},
        "mcp_exposure": {name: {"directTools": cfg["directTools"], "lifecycle": cfg["lifecycle"]}
                         for name, cfg in mcp["mcpServers"].items()},
        "project_context_files_not_global": sorted(
            [{"path": str(p), **measure(p)} for p in repo.parent.glob("*/AGENTS*.md")],
            key=lambda item: item["bytes"], reverse=True),
        "installed_skill_files_not_eager_bodies": sorted(
            [{"path": str(p), **measure(p)} for p in (Path.home() / ".agents/skills").glob("*/SKILL.md")],
            key=lambda item: item["bytes"], reverse=True),
    }
    if args.installed:
        home = Path.home()
        expected = core.read_bytes()
        checks = {}
        for relative in [".pi/agent/AGENTS.md", ".codex/AGENTS.md"]:
            p = home / relative
            checks[relative] = p.is_file() and p.read_bytes() == expected
        claude = home / ".claude/CLAUDE.md"
        checks[".claude/CLAUDE.md"] = claude.is_file() and claude.read_text().strip() == "@~/.pi/agent/AGENTS.md"
        for relative in sorted(set(re.findall(r"~/(\.config/myagent/reference/[a-z-]+\.md)", core.read_text()))):
            p = home / relative
            checks[relative] = p.is_file() and p.read_bytes() == (args.myrig / "home" / relative).read_bytes()
        report["installed_instruction_checks"] = checks
        print(json.dumps(report, indent=2))
        return 0 if all(checks.values()) else 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
