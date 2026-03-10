---
name: http-request
description: Make HTTP requests to APIs and endpoints. Use before browser for JSON APIs.
roles: [coordinator, advisor, director, inspector, ops]
tools: [http_request]
---

## HTTP Request

Use `http_request` for APIs, health checks, and any endpoint that returns
structured data. This is the right tool before reaching for `browser`.

### Parameters

| Param | Default | Notes |
|---|---|---|
| `url` | — | Required. The endpoint URL. |
| `method` | `GET` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `headers` | — | Key-value map of request headers |
| `body` | — | String body for POST/PUT/PATCH |
| `json` | — | Object — serialized to JSON and sets `Content-Type: application/json` |

### Common patterns

```
// Health check
{ url: "https://api.example.com/health" }

// JSON POST
{ url: "https://api.example.com/items", method: "POST", json: { name: "foo" } }

// With auth header
{ url: "https://api.example.com/me", headers: { Authorization: "Bearer TOKEN" } }
```

### When to prefer browser instead

Use `browser` when the endpoint requires a full browser session, sets cookies
via JavaScript, or renders content that is not in the initial HTML/JSON response.
