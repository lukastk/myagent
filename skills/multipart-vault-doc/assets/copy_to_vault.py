#!/usr/bin/env python3
"""
TEMPLATE — copy a local multipart-vault-doc folder into myvault.

Generic logic (slug<->title mapping, wikilink rewriting, idempotency, BACKUP-before-overwrite,
verification) is complete and reusable as-is. The ONE vault-specific piece — actually creating a
note (and computing its on-disk path) — is delegated to the `myvault` skill: fill in
`target_path()` and `create_note()` using whatever the `myvault` skill currently specifies (do
NOT hardcode mysystem internals from memory; read them from that skill, since they can change).

Per-use, edit:
  - SRC                : the local doc folder
  - MAIN_DOC_TITLE     : the title Lukas wants for the main (Document) note
  - SUB_PREFIX         : a distinctive prefix for the Null sub-notes
  - MAPPING            : ordered (slug, title, note_kind) — main doc first, glossary last
  - target_path()      : per the `myvault` skill (vault path + folder for the note kind)
  - create_note()      : per the `myvault` skill (note types, create command, stage:live, folders)

WHY THE BACKUP MATTERS: `create` refuses to overwrite, so each run deletes the existing target
first. If Lukas has hand-edited a note in the vault since the last copy (e.g. `==…==` review
highlights), a naive delete loses it silently. This template ALWAYS copies an existing target to
a timestamped tmp backup before deleting, so manual edits are recoverable. Do not remove this.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "design_doc"                       # <-- the local doc folder

MAIN_DOC_TITLE = "REPLACE - Main Doc Title"     # <-- main note title (a Document note)
SUB_PREFIX = "REPLACE Prefix -"                 # <-- sub-note title prefix (Null notes)

# Ordered (local slug, vault note title, note_kind). Main doc ("index") first; glossary last.
# note_kind is "main" (Document note) or "sub" (Null note); map these to the actual myvault
# note types inside target_path()/create_note().
MAPPING = [
    ("index",            MAIN_DOC_TITLE,                       "main"),
    ("00_overview",      f"{SUB_PREFIX} 00 Overview",          "sub"),
    # ("01_...",         f"{SUB_PREFIX} 01 ...",               "sub"),
    # ...
    # ("NN_glossary",    f"{SUB_PREFIX} NN Glossary",          "sub"),
]

SLUG_TO_TITLE = {slug: title for slug, title, _ in MAPPING}

# One backup directory per run; existing targets are copied here before being overwritten.
BACKUP_DIR = Path(tempfile.gettempdir()) / "multipart-vault-doc-backups" / datetime.now().strftime("%Y%m%d-%H%M%S")


def rewrite_links(text: str) -> str:
    """Rewrite [[slug]], [[slug#anchor]], [[slug|alias]], [[slug#anchor|alias]] -> vault title.
    Anchored on '[[' so it catches nav footers and glossary anchors; longest slug first."""
    for slug in sorted(SLUG_TO_TITLE, key=len, reverse=True):
        text = text.replace(f"[[{slug}", f"[[{SLUG_TO_TITLE[slug]}")
    return text


def target_path(title: str, note_kind: str) -> Path:
    """DELEGATED TO THE `myvault` SKILL.

    Return the absolute on-disk path of the note (vault path + folder + f"{title}.md").
      - note_kind == "main" -> the Document folder
      - note_kind == "sub"  -> the Null folder
    Read the vault path and folders from the `myvault` skill; do not hardcode from memory.
    """
    raise NotImplementedError("Fill in target_path() per the `myvault` skill (vault path + folders).")


def create_note(title: str, note_kind: str, body: str) -> None:
    """DELEGATED TO THE `myvault` SKILL.

    Implement using its current conventions:
      - note_kind == "main" -> a Document note (longer-form doc), titled `title`
      - note_kind == "sub"  -> a Null note in the null folder, referenced by the main doc
      - create the typed note with `body` passed via stdin, and set stage: live
    The existing target file has already been backed up and deleted by main() before this call.
    Keep the vault path / CLI exactly as `myvault` specifies; do not hardcode from memory here.
    """
    raise NotImplementedError(
        "Fill in create_note() per the `myvault` skill (note types, create command, stage:live)."
    )


def main() -> int:
    if not SRC.is_dir():
        print(f"ERROR: source folder not found: {SRC}", file=sys.stderr)
        return 1
    backed_up = 0
    for slug, title, note_kind in MAPPING:
        src_file = SRC / f"{slug}.md"
        if not src_file.is_file():
            print(f"ERROR: missing source file {src_file}", file=sys.stderr)
            return 1
        body = rewrite_links(src_file.read_text())

        # SAFETY: back up any existing target before it gets overwritten, then delete it
        # (create refuses to overwrite). This is what makes re-runs non-destructive.
        dest = target_path(title, note_kind)
        if dest.exists():
            bak = BACKUP_DIR / dest.parent.name / dest.name
            bak.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, bak)
            backed_up += 1
            dest.unlink()

        create_note(title, note_kind, body)
        print(f"  ✓ {title}")

    if backed_up:
        print(f"\nBacked up {backed_up} pre-existing note(s) to: {BACKUP_DIR}")
    print(f"Done. Main doc + {len(MAPPING) - 1} sub-notes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
