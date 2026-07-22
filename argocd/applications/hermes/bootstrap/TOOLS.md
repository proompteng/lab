# TOOLS.md - Production Notes

- Mutable workspace: `/opt/data/workspace/tuslagch`.
- Curated memory: `/opt/data/memories`.
- Primary model: `qwen36-flamingo` through the internal Flamingo service.
- Default agent working directory and local lab checkout: `/opt/data/workspace/tuslagch/lab`.
- GitHub CLI `2.96.0` and Git are authenticated as `tuslagch`; use `codex/` branches and pull requests for authorized changes.
- The immutable Lab toolchain provides Node `24.11.1`, Bun/Bunx `1.3.14`, Go `1.25.5`, Helm `3.19.1`, Kustomize
  `5.8.0`, kubeconform `0.7.0`, ShellCheck `0.11.0`, jq `1.8.1`, and yq `4.49.2` from `/opt/lab-toolchain/bin`.
- `kubectl` has cluster-wide read access to non-secret resources. Writes, Kubernetes Secrets, exec, attach, copy, proxy, and
  port-forward are denied by RBAC.
- Host mounts, container sockets, cloud fallbacks, MCP servers, cron, dashboard, and delegation are not available.
- Public HTTPS egress is forced through the operator-managed proxy. Direct public egress and private, tailnet,
  link-local/metadata, multicast, and reserved destinations remain blocked.
- The authenticated API is for canary and operator validation; possession of its key is equivalent to trusted operator access.

Do not add credentials or private infrastructure details to this file.
