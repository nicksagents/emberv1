---
name: files
description: File system read, write, edit, and directory listing tools.
roles: [coordinator, advisor, director, inspector]
tools: [read_file, write_file, edit_file, list_directory]
---

## File Tools

### `read_file`

Read the real file contents before quoting, analyzing, or editing. Always read
before editing — never assume you know the current content.

- Use `start_line` / `end_line` to limit reads when the file is large
- Read only the sections you need — avoid reading entire large files repeatedly

### `write_file`

Creates a new file or fully replaces an existing one. Use only when a complete
rewrite is intended.

- Prefer `edit_file` for localized changes to existing files
- `write_file` on an existing file discards all content not in your write

### `edit_file`

Make a targeted replacement in an existing file. Requires the exact text to be
replaced (`old_string`).

- **Read the file first** — `old_string` must match the file exactly
- `old_string` must appear exactly once unless `replace_all: true` is set
- Keep `old_string` long enough to be unique — include surrounding context
- For multi-location changes, make one edit per call and re-read between edits

### `list_directory`

List directory contents before guessing file paths or project structure.

- Use `recursive: true` with `max_depth` to limit scan scope
- Use `include_hidden: true` to see dotfiles and config directories
- Run this before `read_file` when you do not know the exact file name
