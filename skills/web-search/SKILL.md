---
name: web-search
description: Search the web for current information. Always follow up with fetch_page to read results.
roles: [coordinator, advisor, director, inspector]
tools: [web_search]
---

## Web Search

**Step 1:** `web_search` — get URLs and snippets.
**Step 2:** `fetch_page` on the best URL — read the actual content.

Snippets are never enough. Always fetch the page.

### Use web_search for

- Current events, release notes, changelogs
- Documentation for external libraries
- Error messages that may have known solutions
- Package names, versions, compatibility

### Do not use web_search when

- The answer is already in local files or conversation context
- You already have the relevant documentation

### Query tips

- Use specific keywords, not full sentences
- Wrap exact phrases in "quotes"
- Include version numbers for library issues
- If results are unhelpful, rephrase with different keywords

### After getting results

Use `fetch_page` — not the browser. The browser is only needed if the page
requires login or JavaScript interaction. `fetch_page` handles all public URLs.
