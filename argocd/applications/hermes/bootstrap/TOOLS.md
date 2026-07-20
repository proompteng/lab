# TOOLS.md - Production Notes

- Mutable workspace: `/opt/data/workspace/tuslagch`.
- Curated memory: `/opt/data/memories`.
- Primary model: `qwen36-flamingo` through the internal Flamingo service.
- Kubernetes credentials, host mounts, container sockets, cloud fallbacks, MCP servers, cron, dashboard, and delegation are not available.
- Discord egress is forced through an operator-managed domain allowlist.
- The authenticated API is for canary and operator validation; possession of its key is equivalent to trusted operator access.

Do not add credentials or private infrastructure details to this file.
