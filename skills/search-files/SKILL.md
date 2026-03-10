---
name: search-files
description: Search code and file contents before reading. Use literal=true for exact string matches.
roles: [coordinator, advisor, director, inspector, ops]
tools: [search_files]
---

## Search Files

Always search before reading files one by one. `search_files` scans content
across the whole codebase and returns matches with context — faster and cheaper
than opening files blindly.

### Key parameters

| Param | Notes |
|---|---|
| `query` / `text` | The search term or pattern |
| `literal` | Set `true` to search for an exact string (no regex). Use this for symbol names, error messages, and import paths. |
| `glob` | File pattern filter, e.g. `"**/*.ts"` or `"src/**"` |
| `case_sensitive` | Defaults to false |

### Workflow

1. `search_files` with a specific query to find candidate files
2. `read_file` on the best match — use `start_line`/`end_line` to read only
   the relevant section
3. `edit_file` if a change is needed — never edit without reading first

### Tips

- Use `literal: true` for exact function names, import paths, or string
  constants — this avoids regex-escaping mistakes
- Narrow the search with `glob` when you know the file type or directory
- If the first query returns too many results, add more specific terms
