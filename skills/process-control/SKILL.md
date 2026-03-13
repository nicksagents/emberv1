---
name: process-control
description: List running processes, check ports, kill processes, and inspect system resource usage.
roles: [coordinator, director, inspector]
tools: [process_manager, system_info]
---

## Process Control

### Find what is using a port

```
process_manager action=port_check port=3000
```

### List processes (optionally filter by name)

```
process_manager action=list                    # top CPU consumers
process_manager action=list filter="node"      # only node processes
process_manager action=list filter="python"
process_manager action=list filter="ruby"
```

### Kill a process

```
process_manager action=kill pid=1234           # graceful stop (SIGTERM)
process_manager action=kill name="node"        # stop all matching processes
process_manager action=kill pid=1234 signal=KILL   # force kill (SIGKILL)
```

### Check system resources

```
system_info action=cpu        # CPU cores and load average
system_info action=memory     # RAM used/free
system_info action=disk       # disk space on /
system_info action=all        # full snapshot
```

### Common situations

| Problem | Action |
|---------|--------|
| "Port 3000 already in use" | `process_manager port_check 3000` → `process_manager kill pid=<PID>` |
| Server crashed, need to restart | `process_manager list filter="<name>"` → confirm stopped → restart |
| High CPU / slow system | `system_info cpu` + `process_manager list` → identify hog |
| Zombie background task | `process_manager list filter="<name>"` → `kill` if found |
| Out of memory errors | `system_info memory` → identify pressure → `kill` or restart culprit |

### When to use terminal instead

Use `run_terminal_command` when you need:
- Complex shell pipelines or scripting
- Interactive process management (htop, top)
- Tools not covered by process_manager (e.g. `docker ps`, `pm2 list`)
