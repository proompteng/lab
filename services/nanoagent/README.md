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
- `/v1/preview/{port}/{path...}`: HTTP and WebSocket proxying to an allowed loopback development port.

Filesystem operations are confined with `os.Root`, reject symlink escapes, and hide `.codex` and `.tengri` internal
state. Editable files are capped at 4 MiB, directory traversal and watcher subscriptions are bounded, and cancellation
stops searches and event streams.

Preview requests can reach only `127.0.0.1`, reject privileged and reserved ports, strip credentials and hop-by-hop or
forwarding headers, and support WebSocket upgrades for development-server HMR. Nanoagent never proxies arbitrary
hosts, Kubernetes APIs, cluster addresses, LAN services, metadata endpoints, or Tailscale peers.

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
