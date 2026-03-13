---
name: tailscale
description: Expose local servers over Tailscale mesh VPN (private) or Tailscale Funnel (public internet).
roles: [coordinator, director, advisor]
tools: [run_terminal_command, network_tools]
---

## Tailscale

Tailscale is a mesh VPN. `tailscale serve` shares a local port with your tailnet (private peers only). `tailscale funnel` exposes it to the public internet via a stable HTTPS URL.

### Check status first

```bash
network_tools action=tailscale_status    # confirm running + see peers
network_tools action=tailscale_ip        # get this device's Tailscale IP
```

### Share with tailnet only (private)

```bash
tailscale serve 3000                     # serve localhost:3000 at https://<device>.tailnet.ts.net
tailscale serve --bg 3000                # run in background (persistent across reboots)
tailscale serve status                   # list active serve configs
tailscale serve reset                    # remove all serve configs
tailscale serve --http=80 3000           # serve on plain HTTP (no TLS)
```

### Share publicly via Tailscale Funnel

```bash
tailscale funnel 3000                    # expose to public internet at https://<device>.tailnet.ts.net
tailscale funnel status                  # list active funnels
tailscale funnel reset                   # remove all funnels
```

Funnel requires Funnel to be enabled for your tailnet (Settings → DNS in Tailscale admin).

### Path-based routing

```bash
tailscale serve --set-path /api 3001     # route /api/* to localhost:3001
tailscale serve --set-path /app 3000     # route /app/* to localhost:3000
```

### Install Tailscale

| Platform | Command |
|----------|---------|
| macOS | `brew install tailscale` |
| Linux (Debian/Ubuntu) | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| After install | `sudo tailscale up` (authenticate in browser) |

### Workflow

1. `network_tools action=tailscale_status` — confirm Tailscale is running
2. Start your local server in a named terminal session
3. `tailscale serve <port>` for private sharing, or `tailscale funnel <port>` for public
4. Share the `https://<device>.tailnet.ts.net` URL with collaborators
5. `tailscale serve reset` when done to stop sharing
