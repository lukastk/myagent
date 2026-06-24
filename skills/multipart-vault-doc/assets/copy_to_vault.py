#!/usr/bin/env python3
"""
TEMPLATE — copy a local multipart-vault-doc folder into myvault.

Generic logic (slug<->title mapping, wikilink rewriting, idempotency, verification) is complete
and reusable as-is. The ONE vault-specific piece — actually creating a note — is delegated to the
`myvault` skill: fill in `create_note()` using whatever the `myvault` skill currently specifies
for creating a typed note with a stdin body (do NOT hardcode mysystem internals from memory; read
them from that skill, since they can change).

Per-use, edit:
  - SRC                : the local doc folder
  - MAIN_DOC_TITLE     : the title Lukas wants for the main (Document) note
  - SUB_PREFIX         : a distinctive prefix for the Null sub-notes
  - MAPPING            : ordered (slug, title, note_kind) — main doc first, glossary last
  - create_note()      : per the `myvault` skill (note types, create command, stage:live, folders)
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "design_doc"                       # <-- the local doc folder

MAIN_DOC_TITLE = "REPLACE - Main Doc Title"     # <-- main note title (a Document note)
SUB_PREFIX = "REPLACE Prefix -"                 # <-- sub-note title prefix (Null notes)

# Ordered (local slug, vault note title, note_kind). Main doc ("index") first; glossary last.
# note_kind is "main" (Document note) or "sub" (Null note); map these to the actual myvault
# note types inside create_note().
MAPPING = [
    ("index",            MAIN_DOC_TITLE,                       "main"),
    ("00_overview",      f"{SUB_PREFIX} 00 Overview",          "sub"),
    # ("01_...",         f"{SUB_PREFIX} 01 ...",               "sub"),
    # ...
    # ("NN_glossary",    f"{SUB_PREFIX} NN Glossary",          "sub"),
]

SLUG_TO_TITLE = {slug: title for slug, title, _ in MAPPING}


def rewrite_links(text: str) -> str:
    """Rewrite [[slug]], [[slug#anchor]], [[slug|alias]], [[slug#anchor|alias]] -> vault title.
    Anchored on '[[' so it catches nav footers and glossary anchors; longest slug first."""
    for slug in sorted(SLUG_TO_TITLE, key=len, reverse=True):
        text = text.replace(f"[[{slug}", f"[[{SLUG_TO_TITLE[slug]}")
    return text


def create_note(title: str, note_kind: str, body: str) -> None:
    """DELEGATED TO THE `myvault` SKILL.

    Load the `myvault` skill and implement this using its current conventions:
      - note_kind == "main" -> a Document note (longer-form doc), titled `title`
      - note_kind == "sub"  -> a Null note in the null folder, referenced by the main doc
      - create the typed note with `body` passed via stdin, and set stage: live
      - `create` refuses to overwrite, so delete any existing target file first (idempotency)

    Keep the vault path / CLI exactly as `myvault` specifies; do not hardcode from memory here.
    """
    raise NotImplementedError(
        "Fill in create_note() per the `myvault` skill (note types, create command, stage:live)."
    )


def main() -> int:
    if not SRC.is_dir():
        print(f"ERROR: source folder not found: {SRC}", file=sys.stderr)
        return 1
    for slug, title, note_kind in MAPPING:
        src_file = SRC / f"{slug}.md"
        if not src_file.is_file():
            print(f"ERROR: missing source file {src_file}", file=sys.stderr)
            return 1
        body = rewrite_links(src_file.read_text())
        create_note(title, note_kind, body)
        print(f"  ✓ {title}")
    print(f"\nDone. Main doc + {len(MAPPING) - 1} sub-notes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
