# message-barrel

Save draft messages and paste them later into the input editor.

## Shortcuts

- `Ctrl+Alt+N` — save current editor text into the barrel and clear the editor
- `Ctrl+Alt+B` — open barrel picker and paste the selected message at the current cursor position

## Commands

- `/barrel` — open barrel picker and paste selected message
- `/barrel-save` — save current editor text to barrel and clear editor

## Notes

- Barrel contents are persisted in the session (`custom` entries), so they survive `/reload` and session resume.
- Messages are removed from the barrel after being pasted.
- When the barrel has saved messages, a warning widget is shown below the editor with the current count.
