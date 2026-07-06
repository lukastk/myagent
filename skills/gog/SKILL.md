---
name: gog
description: Use the `gog` CLI to interact with Google services — Gmail, Calendar, Drive, Docs, Sheets, and more. Use this skill whenever the user asks to read/send email, check/manage calendar events, access Google Drive files, or do anything involving their Google accounts or Google Workspace services.
---

## Accounts

| Email | Purpose | Client |
|---|---|---|
| `lukas.kikuchi@gmail.com` | Personal | `default` |
| `kikuchi.lukas@gmail.com` | Autonomy work | `default` |
| `lukas@jackfruiting.com` | Jackfruit work (Google Workspace) | `default` |
| `jimmy.botjangles@gmail.com` | Specialised agent account | `default` |

`kikuchi.lukas@gmail.com` is the Gmail inbox linked to the user's **Autonomy** work identity `lukas@autonomy.work` (mail to `lukas@autonomy.work` is aliased into it) — use it for anything Autonomy-related. `lukas@jackfruiting.com` is the user's **Jackfruit** startup, a Google Workspace account — use it for anything Jackfruit-related.

`jimmy.botjangles@gmail.com` is a **specialised account reserved for agent use**. **Do NOT use it unless Lukas has explicitly authorized it for the task at hand** — never pick it as a default, and never act on it on your own initiative.

All four accounts use the default OAuth client. Tokens are already authorized and stored on all machines.

**Authorized services (differ by account):**
- `lukas.kikuchi@gmail.com`, `kikuchi.lukas@gmail.com`: `gmail`, `calendar`, `drive`, `docs`, `sheets`.
- `lukas@jackfruiting.com`, `jimmy.botjangles@gmail.com`: all 10 user-OAuth services — `gmail`, `calendar`, `drive`, `docs`, `sheets`, `chat`, `contacts`, `tasks`, `people`, `classroom`.

The CLI also exposes `slides`, `groups`, and `keep`, but those scopes are **not** authorized on any account — calling them fails until you re-auth with a wider `--services` list (see "Re-authenticating"). `groups` (Cloud Identity) and `keep` are Workspace-only — `keep` additionally needs a service account with domain-wide delegation — so they're only viable on `lukas@jackfruiting.com` if set up.

## Common commands

`--account <email>` is **required** — there is no default account, so omitting it errors with `missing --account`. (`GOG_ACCOUNT` or `gog auth manage` can set a default, but the convention here is to pass `--account` explicitly.)

Use `--json` for structured output, `--plain` for stable TSV. Most list commands take `--max N`. Destructive writes (delete, etc.) prompt unless you pass `--force`; in scripts add `--no-input` to fail instead of hang.

**Finding IDs:** message / file / doc / sheet IDs come from Google URLs, or from `gmail search` / `drive search`.

### Gmail

```bash
# Read
gog --account lukas.kikuchi@gmail.com gmail search 'in:inbox' --max 10   # Gmail query syntax
gog --account lukas.kikuchi@gmail.com gmail get <messageId> --format full
gog --account lukas.kikuchi@gmail.com gmail attachment <messageId> <attachmentId> --out ./file
# Write
gog --account lukas.kikuchi@gmail.com gmail send --to a@b.com --subject "Hi" --body "..."
gog --account lukas.kikuchi@gmail.com gmail drafts create --to a@b.com --subject "Hi" --body "..."
```

### Calendar

```bash
gog --account lukas.kikuchi@gmail.com calendar events --today          # also --tomorrow, --all
gog --account lukas.kikuchi@gmail.com calendar events --from 2026-05-14 --to 2026-05-21
gog --account lukas.kikuchi@gmail.com calendar create primary --summary "Meeting" --from "2026-05-14T10:00:00+01:00" --to "2026-05-14T10:30:00+01:00"
gog --account lukas.kikuchi@gmail.com calendar update primary <eventId> --summary "Renamed"
gog --account lukas.kikuchi@gmail.com calendar delete primary <eventId>
gog --account lukas.kikuchi@gmail.com calendar freebusy primary --from 2026-06-03 --to 2026-06-04
```

### Drive

```bash
gog --account lukas.kikuchi@gmail.com drive ls --parent <folderId>      # default: root
gog --account lukas.kikuchi@gmail.com drive search 'query'              # full-text, not filename
gog --account lukas.kikuchi@gmail.com drive get <fileId>                # METADATA only — not content
gog --account lukas.kikuchi@gmail.com drive download <fileId> --out ./f # file CONTENT (exports Google formats)
gog --account lukas.kikuchi@gmail.com drive upload <localPath> --parent <folderId>
gog --account lukas.kikuchi@gmail.com drive mkdir <name> --parent <folderId>
```

To read the *content* of a native Google file, use `docs cat` / `sheets get` (below), not `drive get`.

### Docs and Sheets

```bash
gog --account lukas.kikuchi@gmail.com docs cat <docId>                       # plain text
gog --account lukas.kikuchi@gmail.com docs export <docId> --format pdf --out ./d.pdf
gog --account lukas.kikuchi@gmail.com sheets get <spreadsheetId> '<range>'
gog --account lukas.kikuchi@gmail.com sheets update <spreadsheetId> '<range>' val1 val2 ...
gog --account lukas.kikuchi@gmail.com sheets append <spreadsheetId> '<range>' val1 val2 ...
```

To create a native Google Doc from a `.md` file, see "Uploading markdown as a native Google Doc" below (`drive upload` does **not** convert).

## Known folder IDs

These are folders Lukas has pointed to in past sessions. Use these
when you need to put something "in the Autonomy Data Unit folder" or
"in the projects folder" — they aren't easily discoverable via
`drive search` because that does full-text search rather than name
matching, and Drive's natural-language search is unreliable for folder
titles.

| Folder | ID | Account |
|---|---|---|
| Autonomy Data Unit (root) | `165hMDiXLKSDU10KB2jiA2Fa5_QDtPcfu` | `kikuchi.lukas@gmail.com` |
| Autonomy Data Unit → projects | `1kb2EJH0WvhK-tf5YycsOZqbAa544Qn4c` | `kikuchi.lukas@gmail.com` |

If Lukas mentions a new persistent folder ("the X folder"), add it here.

## Uploading markdown as a native Google Doc

`gog drive upload <file.md>` uploads as raw `text/markdown` — it does NOT
convert to a Google Doc. To get a real Doc from a `.md` file you need
the Drive API with `mimeType: application/vnd.google-apps.document` set
on the metadata; Drive then runs its markdown importer. The pattern,
reusing gog's stored refresh token:

```python
import io, json, subprocess, sys
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

# Export gog's cached refresh token to a temp file
subprocess.run(["gog", "auth", "tokens", "export", "<email>",
                "--out", "/tmp/_t.json", "--overwrite"], check=True)
cache = json.load(open("/tmp/_t.json"))
# gog's config root is platform-specific — macOS: ~/Library/Application Support/gogcli/,
# Linux: ~/.config/gogcli/. credentials.json (the OAuth client) only exists on the
# machine where OAuth consent was first set up; copy it over if it's missing.
gog_config = (Path.home() / "Library/Application Support/gogcli") \
    if sys.platform == "darwin" else (Path.home() / ".config/gogcli")
client = json.load(open(gog_config / "credentials.json"))
creds = Credentials(
    token=None, refresh_token=cache["refresh_token"],
    token_uri="https://oauth2.googleapis.com/token",
    client_id=client["client_id"], client_secret=client["client_secret"],
    scopes=cache.get("scopes"),
)
creds.refresh(Request())
svc = build("drive", "v3", credentials=creds, cache_discovery=False)

media = MediaIoBaseUpload(io.BytesIO(open("foo.md","rb").read()),
                          mimetype="text/markdown")
f = svc.files().create(
    body={"name": "Foo", "mimeType": "application/vnd.google-apps.document",
          "parents": ["<folderId>"]},
    media_body=media, fields="id,webViewLink",
).execute()
```

Important gotchas the Drive markdown importer hits:
- Image embeds `![alt](path.png)` crash the converter (500 error).
  Strip them or rewrite as plain links before uploading.
- Use `files().update(media_body=...)` to re-import a new markdown body
  into an existing Doc — preserves the doc ID and any sharing.
- The 500 errors are sometimes transient; retry with exponential backoff.

## Environment

`GOG_KEYRING_PASSWORD` is set via shell init on all machines — no manual auth or password prompts needed. The CLI works in both interactive and non-interactive (SSH/script) contexts.

## Re-authenticating

If a `gog` command fails with an authentication error (token expired, missing scopes, etc.), tell the user to re-authorize with:

```bash
gog auth add <email> --services gmail,calendar,drive,docs,sheets --force-consent
```

| Account | Command |
|---|---|
| Personal | `gog auth add lukas.kikuchi@gmail.com --services gmail,calendar,drive,docs,sheets --force-consent` |
| Autonomy work | `gog auth add kikuchi.lukas@gmail.com --services gmail,calendar,drive,docs,sheets --force-consent` |
| Jackfruit work | `gog auth add lukas@jackfruiting.com --services all --force-consent` |
| Agent account | `gog auth add jimmy.botjangles@gmail.com --services all --force-consent` |

This opens a browser for interactive OAuth consent. After re-authorizing, run `gog-auth-bootstrap-all` to distribute the new tokens to all machines.

## Machine targets

Gog is available on all machines:

| Machine | SSH |
|---|---|
| mac (local) | n/a |
| mymain | `ssh lukastk@mymain` |
| termux | `ssh -p 8022 lukas@android-main` |

When running commands on remote machines, always SSH in and run the gog command directly — the tokens are already there.
