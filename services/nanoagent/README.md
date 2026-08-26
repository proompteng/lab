# Nanoagent

Nanoagent is Tengri's private guest service. It runs as UID/GID `1000` inside the Ubuntu 24.04 workload that Kata
Containers boots in a Firecracker microVM. It is neither a Kubernetes controller nor a desktop application. Tengri
alone reaches it using a random bootstrap bearer token stored in a per-`MicroVM` immutable Secret.

The multi-architecture guest contains Bash, Git, OpenSSH, curl, jq, ripgrep, Node/npm, Bun, Python/uv, Go, Rust, and
the pinned Codex CLI. The system root is read-only at runtime. A 16 GiB PVC is mounted at `/home/nanoagent`, with
`/workspace` resolving to `/home/nanoagent/workspace`; Codex login, threads, source files, shell configuration, and
user-installed tools therefore survive idle sleep and Pod recreation.
Global npm tools, uv tools, Cargo installs, Go installs, and Bun installs resolve into this persistent home; package
caches alone use bounded `/tmp` space.

## API

`GET /livez`, `GET /readyz`, and the compatibility alias `GET /healthz` are the only unauthenticated probe endpoints.
`/livez` proves the process is serving; `/readyz` and `/healthz` remain unavailable until the supervised Codex
app-server completes its initialization handshake. Every `/v1/*` request, including `/v1/evidence`, requires
`Authorization: Bearer $MICROVM_BOOTSTRAP_TOKEN`; evidence never includes a token or token-derived value.

- `/v1/files`, `/v1/files/content`, `/v1/files/directory`, `/v1/files/move`, `/v1/files/search`, and
  `/v1/files/watch` provide confined filesystem CRUD, filename search, and replayable change events. Directory lists
  are capped at 10,000 entries; watches cover only the requested directory and are registered on demand (up to 32
  unique directories and 16 live subscribers), so a large persistent home is never recursively watched.
- `/v1/terminals` creates and lists at most four real Bash PTYs. `/v1/terminals/{id}/ws` carries framed binary output,
  input, resize, reconnect, replay, ping/pong, and termination.
- `/v1/codex/call`, `/v1/codex/events`, and `/v1/codex/approvals/{id}` supervise one persistent
  `codex app-server`, complete its `initialize`/`initialized` handshake, expose an allowlisted typed RPC surface, and
  preserve approval control in Tengri.
- `/v1/preview/{port}/...` proxies HTTP and WebSocket upgrades only to loopback inside the guest. It strips the
  Nanoagent bearer token and forwarding headers before contacting the development server.

Workspace resolution rejects traversal, symlink escapes, and Tengri metadata paths. Preview cannot select an upstream
host. Nanoagent never injects a shared OpenAI API key and never logs terminal input, file content, or prompts.

## Terminal framing

Binary server frames are `0x01 | uint32 big-endian sequence | bytes`. Text frames are control messages. The initial
`ready` message returns the reconnect token and replay bounds. Clients reconnect with `reconnect` and `since` query
parameters; a `reset` control message means the requested sequence fell outside the bounded replay buffer.

## Local validation

```bash
GOWORK=off go test ./...
GOWORK=off go vet ./...
MICROVM_ID=local \
  MICROVM_BOOTSTRAP_TOKEN=development-only \
  NANOAGENT_HOME="$PWD/.local-home" \
  NANOAGENT_WORKSPACE="$PWD/.local-home" \
  go run .
```

The release workflow builds `linux/amd64` and `linux/arm64`, publishes to
`registry.ide-newton.ts.net/lab/nanoagent`, records the manifest digest, and updates GitOps to an immutable digest.
