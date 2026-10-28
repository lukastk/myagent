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

**Authorized services:** all four accounts hold the same 10 user-OAuth services — `gmail`, `calendar`, `drive`, `docs`, `sheets`, `chat`, `contacts`, `tasks`, `people`, `classroom` (check with `gog auth list`).

The CLI also exposes `slides`, `groups`, and `keep`, whose scopes are **not** authorized on any account. `slides create` still works, because gog creates the presentation through the Drive API (verified 2026-10-28); the other `slides` subcommands use the Slides API and fail until you re-auth with a wider `--services` list (see "Re-authenticating"). `groups` (Cloud Identity) and `keep` are Workspace-only — `keep` additionally needs a service account with domain-wide delegation — so they're only viable on `lukas@jackfruiting.com` if set up.

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

To create a native Google Doc from a `.md` file: `gog --account … drive upload foo.md --parent <folderId> --convert-to doc` (see "Uploading markdown as a native Google Doc" below). To create an **empty** Doc, Sheet or Slides file, use `create-gdoc` (next section).

## Creating an empty Doc, Sheet or Slides: `create-gdoc`

When Lukas asks to **create a new Google Doc, Sheet or Slides** file, use the
myrig command `create-gdoc` (`home/.mybin/create-gdoc` in myrig, on PATH on
every machine) rather than hand-rolling `gog … create`. It finds the account's
Share folder by name, applies the Share naming convention, and can share the
file in one step.

```bash
create-gdoc "Meeting notes" -u kikuchi.lukas -t doc -s private   # → "2026-10-28 Meeting notes"
create-gdoc -u lukas.kikuchi@gmail.com -t sheet -s private        # no name → "2026-10-28 14-05-33"
create-gdoc Plan -u jack -t doc --from plan.md -s private         # Markdown file → new Doc
url=$(create-gdoc Deck -u jack -t slides -s private --no-open)    # summary on stderr, URL on stdout
create-gdoc Deck -u jack -t slides -s private --json              # {id,name,type,url,account,folder,share,permission}
```

- `-u/--user` takes an email or a unique part of one (`jack`, `jimmy`, `kikuchi.l`, `lukas.kikuchi`); the accounts come from `gog auth list`.
- `-t/--type` is `doc`, `sheet` or `slides`; `-s/--share` is `private`, `viewer`, `commenter` or `editor` (the last three grant anyone with the link that role, link-only).
- Other flags: `--folder <id>` to create outside Share, `--from <file.md>` (doc only), `--no-date`, `--open`/`--no-open` (macOS opens the file by default), `--json`, `--dry-run`, `--help`.
- **Agents must pass `-u`, `-t` and `-s` explicitly.** The fzf pickers only run when stdin is a terminal; without one `-u` is required and the defaults are `doc` and `private`. Use a sharing level other than `private` only when Lukas has explicitly asked for the file to be shared.
- Created files are named `YYYY-MM-DD <name>` (a space after the date), which is the form Lukas chose for files created this way; uploads keep the `YYYY-MM-DD_` form described in the next section.

Raw gog equivalents, for a different folder or no date prefix:

```bash
gog --account … docs create "Title" --parent <folderId> [--file notes.md] --json    # result: file.id / file.webViewLink
gog --account … sheets create "Title" --parent <folderId> --json                    # result: spreadsheetId / spreadsheetUrl
gog --account … slides create "Title" --parent <folderId> --json                    # drive scope suffices
gog --account … drive share <fileId> --to anyone --role reader|commenter|writer --force --no-input
```

## Default Drive upload target: the Share folder

When Lukas asks to **upload a file to Drive** for one of his accounts and does
**not** specify a destination, default to uploading it into that account's
**Share** folder.

- **One file** → upload directly into the account's Share folder.
- **Several files** → create a subfolder inside Share
  (`drive mkdir <name> --parent <shareFolderId>`) and upload the files into it
  (`--parent <newSubfolderId>`).

**Naming convention (Share folder only):** unless Lukas gives a name, prepend the
uploaded file's / subfolder's name with `YYYY-MM-DD_` of the current date — e.g.
`2026-07-09_report.pdf`, or a subfolder `2026-07-09_screenshots/`. Use
`--name` on `drive upload` to set it. This date-prefix convention applies **only**
to things going into the Share folder, not to uploads elsewhere.

**"Share" is only the folder's name — it does NOT mean make the file public.**
Do not touch the file's sharing or permissions. Placing a file in Share does not
grant anyone-with-link or public access, and you must not add any. Leave
permissions exactly as Drive sets them by default, unless Lukas explicitly asks
to share the file.

The IDs below were re-verified on 2026-10-28 with the query that finds the
folder by name, which is also what `create-gdoc` runs at run time:

```bash
gog --account <email> drive ls --parent root \
  --query "name = 'Share' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" \
  --json | jq -r '.files[].id'
```

| Account | Share folder ID |
|---|---|
| `kikuchi.lukas@gmail.com` (Autonomy) | `1R3KtS1kAgt3_6Eo5Y5G9xC7FAAoXnKc8` |
| `lukas.kikuchi@gmail.com` (Personal) | `0B4Vd1jCrq3XkdWVaUkVvekpHUWs` |
| `lukas@jackfruiting.com` (Jackfruit) | `1PViWr8ThjDhHS5BtbP83LS-BfzpwlxWM` |
| `jimmy.botjangles@gmail.com` (Agent) | `1pmcKG9sxWoJsdmSyDaq13qYL_zwdQADD` |

(The `lukas.kikuchi@gmail.com` folder is a legacy Drive ID; its share URL carries
a `resourceKey`, but the plain folder ID above works for owner uploads via `gog`
— no resourceKey needed.)

```bash
# Single file → Share folder, date-prefixed
gog --account kikuchi.lukas@gmail.com drive upload ./report.pdf \
  --parent 1R3KtS1kAgt3_6Eo5Y5G9xC7FAAoXnKc8 --name 2026-07-09_report.pdf

# Several files → dated subfolder inside Share (mkdir returns the new folder's id)
sub=$(gog --account kikuchi.lukas@gmail.com drive mkdir 2026-07-09_exports \
  --parent 1R3KtS1kAgt3_6Eo5Y5G9xC7FAAoXnKc8 --json | jq -r .id)
gog --account kikuchi.lukas@gmail.com drive upload ./a.csv --parent "$sub"
gog --account kikuchi.lukas@gmail.com drive upload ./b.csv --parent "$sub"
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

Plain `gog drive upload <file.md>` uploads raw `text/markdown`. To get a
real Google Doc, ask gog to convert — Drive then runs its markdown importer:

```bash
gog --account lukas.kikuchi@gmail.com drive upload ./foo.md --parent <folderId> --convert-to doc
# --convert picks the native format from the file extension instead.
# YAML frontmatter is stripped on conversion; --keep-frontmatter keeps it.
```

Conversion is **create-only** in gog. To **re-import markdown into an
EXISTING Doc** (keeping its doc ID and sharing), go through the Drive API
directly — `files().update(media_body=...)` on the Doc's ID. The pattern,
reusing gog's stored refresh token (the example below shows the create
call; swap in `svc.files().update(fileId="<docId>", media_body=media)`):

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

Important gotchas the Drive markdown importer hits (whether via gog or the API):
- Image embeds `![alt](path.png)` crash the converter (500 error).
  Strip them or rewrite as plain links before uploading.
- The 500 errors are sometimes transient; retry with exponential backoff.

## Environment

`GOG_KEYRING_PASSWORD` is set via shell init on all machines — no manual auth or password prompts needed. The CLI works in both interactive and non-interactive (SSH/script) contexts.

myrig's installer keeps gog at the latest release on every OS (Homebrew `gogcli` with `latest=True` on macOS, `go install …@latest` on Linux); `gog --version` shows a machine's build (v0.47.1 everywhere on 2026-10-28). An `unknown flag` error means that machine's gog is stale, not that the flag is wrong.

## Re-authenticating

If a `gog` command fails with an authentication error (token expired, missing scopes, etc.), tell the user to re-authorize with:

```bash
gog auth add <email> --services all --force-consent
```

Always pass `--services all` (the same default `gog-auth-bootstrap-all` uses) — every account holds the full set, and re-authorizing with a narrower list would cut its token down to just those scopes.

| Account | Command |
|---|---|
| Personal | `gog auth add lukas.kikuchi@gmail.com --services all --force-consent` |
| Autonomy work | `gog auth add kikuchi.lukas@gmail.com --services all --force-consent` |
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
