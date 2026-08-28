# Nanoagent guest API

Nanoagent is the unprivileged guest process inside every Tengri `kata-fc` microVM. It is not a Kubernetes controller,
AgentRun runtime, privileged launcher, or node daemon. The Rust Tengri control plane is its only caller.

The process requires `MICROVM_ID` and a bootstrap-only `MICROVM_BOOTSTRAP_TOKEN`. Before starting any API or terminal,
the short-lived container entry process passes that credential through a one-use anonymous pipe and replaces itself
with a clean-environment Nanoagent process. The long-lived process disables Linux dumpability, closes the pipe after
reading it, and never returns, hashes into public metadata, or logs the credential. Public health probes remain
unauthenticated.

## Current API

- `GET /livez`, `GET /readyz`, and `GET /healthz`: process probes;
- `GET /v1/evidence`: guest boot ID, kernel release, architecture, and microVM identity;
- `GET /v1/files`, `GET /v1/files/content`, and `GET /v1/files/search`: bounded file discovery and reads;
- `PUT /v1/files/content`, `POST /v1/files/directory`, `POST /v1/files/move`, and `DELETE /v1/files`: atomic mutations;
- `GET /v1/files/watch`: bounded, replayable filesystem events;
- `POST /v1/terminals`, `GET /v1/terminals`, and `DELETE /v1/terminals/{id}`: PTY lifecycle;
- `GET /v1/terminals/{id}/ws`: interactive terminal attachment, resize, signals, replay, and reconnect;
- `POST /v1/codex/call`: authenticated Codex account, login, thread, turn, steering, and interruption calls;
- `GET /v1/codex/events`: bounded, replayable Codex app-server events;
- `POST /v1/codex/approvals/{id}`: resolve a pending Codex approval request;
- `/v1/preview/{port}/{path...}`: HTTP and WebSocket proxying to an allowed loopback development port.

Filesystem operations are confined with `os.Root`, reject symlink escapes, and hide `.codex` and `.tengri` internal
state. Editable files are capped at 4 MiB, directory traversal and watcher subscriptions are bounded, and cancellation
stops searches and event streams.

Preview requests can reach only `127.0.0.1`, reject privileged and reserved ports, strip credentials and hop-by-hop or
forwarding headers, and support WebSocket upgrades for development-server HMR. Nanoagent never proxies arbitrary
hosts, Kubernetes APIs, cluster addresses, LAN services, metadata endpoints, or Tailscale peers.

Terminal sessions use real PTYs, cap each agent at four sessions and four clients per session, and retain a bounded
sequence-numbered output replay window for reconnects. The bootstrap credential is removed from child environments;
resize, signals, disconnects, idle expiry, and Nanoagent shutdown clean up the complete process group. Cleanup
observes the Linux session leader through a pidfd and leaves the exited leader unreaped until cleanup completes. That
keeps the original numeric session ID allocated while Nanoagent includes descendants that sanitize their environment
and rescans before delayed escalation. Every signal revalidates the target's session and process start time, so cleanup
cannot target a replacement terminal. Non-Linux development hosts retain process-group cleanup when Linux process
identity metadata is unavailable.

Nanoagent supervises one long-lived `codex app-server` process, waits for protocol initialization before reporting
ready, and restarts failed processes with bounded backoff. Every Codex call response includes the event sequence
captured atomically when its app-server response is received, so thread snapshots can be reconciled with independently
delivered event streams without duplication. Device login and thread state persist under the private PVC-backed
`.codex` directory. Events and approvals are typed, bounded, and replayable after reconnect; Nanoagent does not inject
a shared `OPENAI_API_KEY`.

The owner-scoped browser-to-guest flow, replay behavior, and live acceptance procedure are documented in
[`../../docs/tengri/agent-chat.md`](../../docs/tengri/agent-chat.md).

## Local validation

```bash
cd services/nanoagent
gofmt -w *.go
go vet ./...
go test ./...
go test -race ./...
```

Start a local instance with a temporary persistent workspace:

```bash
MICROVM_ID=local \
MICROVM_BOOTSTRAP_TOKEN=development-only \
NANOAGENT_HOME=/tmp/nanoagent-home \
NANOAGENT_WORKSPACE=/tmp/nanoagent-home/workspace \
go run .
```

The Nanoagent workflow runs the focused Go validation. Tengri's image workflow then builds native `linux/amd64` and
`linux/arm64` Nanoagent images alongside the controller, publishes and keylessly signs
`registry.ide-newton.ts.net/lab/nanoagent` by immutable digest, and updates both GitOps digests atomically.
