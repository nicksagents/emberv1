---
name: web-search
description: Search the web for current or external information. Always follow up with fetch_page.
roles: [coordinator, advisor, director, inspector]
tools: [web_search]
---

## Web Search

Use `web_search` for current events, library documentation, error messages, or
anything that is not in the local codebase.

### Workflow

1. `web_search` with a specific query
2. `fetch_page` on the most relevant result — snippets are never enough evidence

### Writing good queries

- Use specific, literal terms from the error or topic
- Wrap exact phrases in `"quotes"` for precise matching
- Include version numbers when searching for library-specific issues
- If the first results are unhelpful, rephrase before giving up — try synonyms
  or remove qualifiers

### When to search vs. when not to

**Search when:**
- The question involves current events, release notes, or changelogs
- You need documentation for an external library
- You have an error message that may have a known solution

**Do not search when:**
- The answer is available from local files or the codebase
- You already have the necessary documentation in context
