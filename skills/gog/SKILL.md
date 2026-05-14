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
gog --account lukas.kikuchi@gmail.com gmail get <messageId> --sanitize-content
gog --account lukas.kikuchi@gmail.com gmail search 'in:inbox' --max 10
```

### Calendar

```bash
gog --account lukas.kikuchi@gmail.com calendar events --today
gog --account lukas.kikuchi@gmail.com calendar events --from 2026-05-14 --to 2026-05-21
gog --account lukas.kikuchi@gmail.com calendar create --summary "Meeting" --from "2026-05-14T10:00:00+01:00" --to "2026-05-14T10:30:00+01:00"
```

### Drive

```bash
gog --account lukas.kikuchi@gmail.com drive ls --parent <folderId>
gog --account lukas.kikuchi@gmail.com drive get <fileId>
gog --account lukas.kikuchi@gmail.com drive tree --parent <folderId>
```

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
