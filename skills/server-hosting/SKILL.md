---
name: server-hosting
description: Start local dev servers, track them across terminal sessions, check ports, and expose them via Tailscale or tunnel tools.
roles: [coordinator, director, advisor]
tools: [run_terminal_command, process_manager, network_tools]
---

## Server Hosting

### Start a server in a named terminal session

Use a named session so you can read output or stop it later without losing it.

```bash
run_terminal_command session="server" command="npm run dev"
run_terminal_command session="server" action="read"       # check output after ~2s
```

### Check if a port is already in use

```
process_manager action=port_check port=3000
```

Kill whatever is using it if needed:
```
process_manager action=kill name="node"     # stop all node processes
process_manager action=kill pid=1234        # stop specific PID
```

### Common server start commands

| Stack | Command | Default port |
|-------|---------|-------------|
| Next.js | `npm run dev` | 3000 |
| Vite (React/Vue) | `npm run dev` | 5173 |
| Express / Fastify | `node src/index.js` | varies |
| Python FastAPI | `uvicorn main:app --reload` | 8000 |
| Python Flask | `flask run` | 5000 |
| Ruby on Rails | `rails server` | 3000 |
| Go | `go run .` | varies |

### Expose to the network

| Tool | Command | Access scope |
|------|---------|-------------|
| Tailscale serve | `tailscale serve <port>` | Tailnet peers only |
| Tailscale funnel | `tailscale funnel <port>` | Public internet |
| localtunnel | `npx localtunnel --port <port>` | Public (no account) |
| ngrok | `ngrok http <port>` | Public (ngrok account) |

### Verify the server is up

```bash
http_request url=http://localhost:3000/         # check root
http_request url=http://localhost:3000/api/health
```

### Stop the server

```bash
run_terminal_command session="server" action=interrupt    # Ctrl-C
process_manager action=kill name="node"                   # force stop
```

### Workflow

1. `process_manager port_check <port>` — ensure port is free
2. `run_terminal_command session="server" command="<start cmd>"` — start server
3. Wait 1–2s, then `run_terminal_command session="server" action=read` — confirm started
4. `http_request url=http://localhost:<port>` — verify it responds
5. Optionally: `tailscale serve <port>` or `tailscale funnel <port>` — expose to network
6. When done: `run_terminal_command session="server" action=interrupt`
