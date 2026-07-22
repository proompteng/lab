# TOOLS.md - Production Notes

- Mutable workspace: `/opt/data/workspace/tuslagch`.
- Curated memory: `/opt/data/memories`.
- Primary model: `qwen36-flamingo` through the internal Flamingo service.
- Default agent working directory and local lab checkout: `/opt/data/workspace/tuslagch/lab`.
- GitHub CLI `2.96.0` and Git are authenticated as `tuslagch`; use `codex/` branches and pull requests for authorized changes.
- `kubectl` has cluster-wide read access to non-secret resources. Writes, Kubernetes Secrets, exec, attach, copy, proxy, and
  port-forward are denied by RBAC.
- Host mounts, container sockets, cloud fallbacks, MCP servers, cron, dashboard, and delegation are not available.
- Public HTTPS egress is forced through the operator-managed proxy. Direct public egress and private, tailnet,
  link-local/metadata, multicast, and reserved destinations remain blocked.
- The authenticated API is for canary and operator validation; possession of its key is equivalent to trusted operator access.

Do not add credentials or private infrastructure details to this file.
