---
name: gog
description: Use the `gog` CLI to interact with Google services — Gmail, Calendar, Drive, Docs, Sheets, and more. Use this skill whenever the user asks to read/send email, check/manage calendar events, access Google Drive files, or do anything involving their Google accounts or Google Workspace services.
---

## Accounts

| Email | Purpose | Client |
|---|---|---|
| `lukas.kikuchi@gmail.com` | Personal | `default` |
| `kikuchi.lukas@gmail.com` | Work | `default` |

Both accounts use the default OAuth client. Tokens are already authorized and stored on all machines.

## Common commands

Use `--account <email>` to target a specific account. Use `--json` for structured output, `--plain` for stable TSV.

### Gmail

```bash
gog --account lukas.kikuchi@gmail.com gmail search 'query' --max N
gog --account lukas.kikuchi@gmail.com gmail get <messageId> --format full
gog --account lukas.kikuchi@gmail.com gmail search 'in:inbox' --max 10
```

### Calendar

```bash
gog --account lukas.kikuchi@gmail.com calendar events --today
gog --account lukas.kikuchi@gmail.com calendar events --from 2026-05-14 --to 2026-05-21
gog --account lukas.kikuchi@gmail.com calendar create primary --summary "Meeting" --from "2026-05-14T10:00:00+01:00" --to "2026-05-14T10:30:00+01:00"
```

### Drive

```bash
gog --account lukas.kikuchi@gmail.com drive ls --parent <folderId>
gog --account lukas.kikuchi@gmail.com drive get <fileId>
```

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
import io, json, subprocess
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

# Export gog's cached refresh token to a temp file
subprocess.run(["gog", "auth", "tokens", "export", "<email>",
                "--out", "/tmp/_t.json", "--overwrite"], check=True)
cache = json.load(open("/tmp/_t.json"))
client = json.load(open(
    "/Users/lukas/Library/Application Support/gogcli/credentials.json"))
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

### Docs and Sheets

```bash
gog --account lukas.kikuchi@gmail.com docs cat <docId>
gog --account lukas.kikuchi@gmail.com sheets get <spreadsheetId> '<range>'
```

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
| Work | `gog auth add kikuchi.lukas@gmail.com --services gmail,calendar,drive,docs,sheets --force-consent` |

This opens a browser for interactive OAuth consent. After re-authorizing, run `gog-auth-bootstrap-all` to distribute the new tokens to all machines.

## Machine targets

Gog is available on all three machines:

| Machine | SSH |
|---|---|
| mac (local) | n/a |
| mymain | `ssh lukastk@mymain` |
| termux | `ssh -p 8022 lukas@android-main` |

When running commands on remote machines, always SSH in and run the gog command directly — the tokens are already there.
