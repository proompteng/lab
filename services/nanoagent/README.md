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
- `GET /v1/codex/login`: the current device-login attempt, so a reconnecting desktop can resume it without
  invalidating the displayed code;
- `GET /v1/codex/events`: bounded, replayable Codex app-server events;
- `POST /v1/codex/approvals/{id}`: resolve a pending Codex approval request;
- `/v1/preview/{port}/{path...}`: HTTP and WebSocket proxying to an allowed loopback development port.

Filesystem operations are confined with `os.Root`, reject symlink escapes, and hide `.codex` and `.tengri` internal
state. Editable files are capped at 4 MiB, directory traversal and watcher subscriptions are bounded, and cancellation
stops searches and event streams.

File-content reads return a strong SHA-256 ETag. Writes require `expectedRevision`, either the exact lowercase
64-hex revision from the read or `missing` for create-only writes. Successful writes return the new revision; stale
writes return HTTP 409. A workspace lock serializes revision comparison and mutation for Nanoagent API writers.
Direct filesystem writers, including shell commands and Codex, do not participate in that lock; their changes are
reported through file events and require editor reconciliation. The API does not claim atomic conditional writes
against arbitrary external processes.

Mutation acknowledgement includes syncing affected directory metadata. A storage failure after a rename or deletion
can leave the mutation visible despite an error response. Re-read the affected path before retrying; an error does
not imply rollback. Retaining the PVC across sleep and releases does not replace an independent backup policy.

Preview requests can reach only `127.0.0.1`, reject privileged and reserved ports, strip credentials and hop-by-hop or
forwarding headers, and support WebSocket upgrades for development-server HMR. Nanoagent never proxies arbitrary
hosts, Kubernetes APIs, cluster addresses, LAN services, metadata endpoints, or Tailscale peers.

Terminal sessions use real PTYs, cap each agent at four sessions and four clients per session, and retain a bounded
sequence-numbered output replay window for reconnects. The bootstrap credential is removed from child environments;
resize, signals, disconnects, idle expiry, and Nanoagent shutdown clean up the complete process group. Cleanup
observes the Linux session leader through a pidfd and leaves the exited leader unreaped until cleanup completes. That
keeps the original numeric session ID allocated while Nanoagent includes descendants that sanitize their environment
and rescans before delayed escalation. Every Linux descendant is pinned with its own pidfd before its session and start
time are revalidated, and the signal is sent through that descriptor so PID reuse cannot retarget cleanup. Non-Linux
development hosts retain process-group cleanup when Linux process identity metadata is unavailable.

Nanoagent supervises one long-lived `codex app-server` process, waits for protocol initialization before reporting
ready, and restarts failed processes with bounded backoff. Every Codex call response includes the event sequence
captured atomically when its app-server response is received, so thread snapshots can be reconciled with independently
delivered event streams without duplication. Device login and thread state persist under the private PVC-backed
`.codex` directory. Events and approvals are typed, bounded, and replayable after reconnect; Nanoagent does not inject
a shared `OPENAI_API_KEY`.

## Firecracker rootfs and persistent tools

Kata's Firecracker snapshotter extracts the guest OCI image into a 512 MiB blockfile. The Dockerfile therefore enforces
a real 512 MiB ext4 population and filesystem check, with at least 16 MiB and 256 inodes left for extraction overhead.
The check runs in a separate build stage and copies only its receipt into the image. Packaged manuals, translated
messages, and documentation other than copyright notices are omitted to keep the guest within that limit.
The image contains a minimal Ubuntu 24.04 shell environment, Nanoagent, and a
compressed multi-architecture bundle for the pinned Node 24.11.1, Bun 1.4.0, uv 0.11.14, Go 1.25.5, Rust/Cargo
1.90.0, and native GCC 13.3.0 guest toolchain. Ubuntu's system `bubblewrap` package satisfies Codex's Linux sandbox
prerequisite instead of showing a bundled-helper fallback warning after device login.

After Nanoagent has moved its bootstrap credential through the one-use pipe and removed the transport variables from
the process environment, `bootstrap-toolchain` atomically installs Node, npm, npx, Bun, Bunx, uv, Go, gofmt, rustc,
Cargo, rustdoc, GCC, and `cc` under the versioned per-architecture `~/.tengri/toolchains` directory. Stable links live
in `~/.local/bin`, the relocatable Go root lives at `~/.local/go`, and subsequent boots validate and reuse the existing
home-volume install. Nanoagent configures both npm and Bun to use `~/.local` as their persistent global prefix, so
globally installed package executables are immediately available from the existing `~/.local/bin` PATH. Rust
compilation and doctests use the bundled architecture-specific `rust-lld` and minimal startup objects through
atomically generated wrappers. Go uses the bundled target-platform GCC and sysroot with CGO enabled by default. Rust,
C, and CGO projects therefore build without `apt`, `sudo`, or any mutation of the read-only guest rootfs.

On first boot, `bootstrap-codex` downloads the architecture-specific Codex 0.153.4 package from the npm registry,
verifies its pinned SHA-512 digest, and atomically installs the complete native package under the 16 GiB PVC-backed
`~/.tengri/codex` directory. Subsequent boots reuse that verified install. Nanoagent does not become ready until the
Codex app server is available, and the `MicroVM` startup probe allows fifteen minutes for the sequential toolchain and
Codex cold boot. Image builds run
the same verified bootstrap without copying its payload into the final image, so a bad checksum or package layout fails
CI before publication. Nanoagent invokes the installer only after its bootstrap credential has moved through the
one-use pipe and been removed from the process environment, so downloader and archive child processes cannot inherit
the credential. The toolchain installer runs through the same sanitized child-process boundary. The initial Nanoagent
process also starts `tini` only through that sanitized re-exec; PID 1 never retains the Kubernetes Secret environment
value.

The owner-scoped browser-to-guest flow, replay behavior, and live acceptance procedure are documented in
[`../../docs/tengri/agent-chat.md`](../../docs/tengri/agent-chat.md).

## Local validation

```bash
cd services/nanoagent
bash -n bootstrap-codex.sh
bash -n bootstrap-toolchain.sh
bash -n validate-rootfs.sh validate-rootfs.test.sh
# On Linux with e2fsprogs and at least 1 GiB of temporary disk space:
bash validate-rootfs.test.sh
bash bootstrap-codex.sh --validate-manifest
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
`registry.ide-newton.ts.net/lab/nanoagent` by immutable digest. CI publishes matching `kargo-sha-<source>` tags for the
controller and guest; the automatic Tengri Warehouse and Stage promote only the matched pair and pin both digests on
`kargo/tengri` for Argo reconciliation.

## VS Code workbench

Authenticated `POST /v1/editor` starts code-server on demand. `bootstrap-code-server.sh` pins version 4.135.0 and verifies
platform-specific SHA-256 digests before installing into `$HOME/.tengri/code-server`. The large upstream payload stays
on the persistent home volume, outside Firecracker's 512 MiB rootfs. Each image build verifies the native Linux archive;
first use requires HTTPS access to GitHub release assets. An unavailable download fails visibly and can be retried.

`CODE_SERVER_BINARY` and `CODE_SERVER_BOOTSTRAP_COMMAND` select the executable and installer. The supervisor starts one
process group per guest with sanitized credentials, a private Unix socket, persistent user settings and extensions under
`$HOME/.tengri/vscode`, and logs at `server.log`. Port 13337 is a virtual preview route to that socket. Port 13338 binds
only loopback for the bundled desktop extension. Both preview routes and native VS Code port forwarding reject reserved
guest ports (8080, 13337, 13338); other application ports retain native forwarding. Shutdown kills the editor process
group and closes bridge connections. The desktop uses the existing authenticated preview gateway; code-server's own
password login is disabled behind that boundary.

Initial settings use Dark Modern, explicit saves, native hot-exit backups, and guest execution for TypeScript language
features. The upstream `remote.extensionKind` override includes `-web` to exclude the browser host, whose TypeScript
bundle is absent from the standalone release. Existing user settings are preserved. Workspace trust remains enabled.
The upstream optional `vsda` browser assets are absent from this open-source distribution; their 404s do not disable the
workbench. Acceptance tests exercise TypeScript diagnostics to detect actual language-extension failures.

See [the desktop acceptance runner](../../apps/landing/README.md#vs-code-in-the-desktop). Existing running guests built
before this API must be slept and resumed onto the current image; the editor reports that requirement explicitly.
