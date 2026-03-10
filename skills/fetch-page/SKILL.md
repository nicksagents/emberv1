---
name: fetch-page
description: Read the actual contents of a URL. Use after web_search or with a direct link.
roles: [coordinator, advisor, director, inspector]
tools: [fetch_page]
---

## Fetch Page

Use `fetch_page` to read the actual content of a web page or document when you
have a URL — either from `web_search` results or a direct link provided by the
user.

### When to use

- After `web_search`, fetch the most relevant result to get real evidence
- When the user provides a documentation URL to read
- When `http_request` returns HTML rather than JSON and you need the readable
  text

### Pagination

Long pages are returned in chunks. Use the `offset` parameter to continue
reading from where the previous call ended. The response will indicate when
there are more pages.

### Do not use for

- API endpoints that return JSON — use `http_request` instead
- Pages that require session cookies or login — use `browser` instead
