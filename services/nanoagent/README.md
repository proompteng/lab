# Nanoagent guest API

Nanoagent runs as UID 1000 inside each Tengri Firecracker guest. Tengri owns the VMM outside the guest, in a normal OCI
slot Pod. The guest has its own Linux kernel, root disk, and retained 16 GiB home. See the
[runtime lifecycle](../tengri/README.md) for the host boundary and snapshot protocol.

The guest `guest-init` helper reads the runner's private boot configuration, mounts the home, and starts Nanoagent as
UID 1000. It passes the slot credential through a one-use anonymous pipe, with a sanitized child environment.
Nanoagent disables Linux dumpability, closes the pipe after
reading it, and never returns, hashes into public metadata, or logs the credential. Public health probes remain
unauthenticated.

## Current API

Tengri uses `proompteng.runtime.guest.v1.NanoagentService` from the shared
[`nanoagent.proto`](../tengri/proto/proompteng/runtime/guest/v1/nanoagent.proto). Nanoagent serves HTTP/2 gRPC and preview
HTTP over private vsock port 1024. Every RPC checks the slot's unique bootstrap credential. Only the host supervisor
can reach this transport, after authenticating the exact Tengri SPIFFE identity and current owner/epoch headers.
Port 8080 binds guest loopback and serves health probes. Host mTLS terminates at the supervisor on port 8443.

SPIRE credentials and its CSI socket stay in the host supervisor. Guest memory contains no SVID, PSAT token, Kubernetes
token, or host Workload API socket. Certificates can rotate while the guest sleeps. The guest administrator can control
the guest, including its bootstrap credential, but cannot authorize another slot or call host lifecycle endpoints.

The service covers editor startup, bounded file discovery and atomic mutations, PTY lifecycle, Codex calls and
approvals, file/Codex server streams, and a bidirectional terminal stream. File content travels as protobuf bytes.
Codex's independently versioned JSON parameters, results, and events travel as bytes inside typed protobuf envelopes;
this preserves numeric IDs and the pinned app-server schema. Browser terminal framing is translated by Tengri.

Tengri authenticates directly to `GetInfo` and verifies the MicroVM identity and protocol version. Guest control is
gRPC-only: the former REST, NDJSON event streams, and terminal WebSocket endpoints have been removed. There is no
HTTP discovery, negotiation, or fallback. Controller and guest artifacts must come from the same validated release.

HTTP remains for process probes and application content:

- `GET /livez`, `GET /readyz`, and `GET /healthz` are process probes on guest loopback port 8080.
- `/v1/preview/{port}/{path...}` proxies an allowed loopback application or VS Code through the host's authenticated vsock connection.

Filesystem operations are confined with `os.Root`, reject symlink escapes, and hide `.codex` and `.tengri` internal
state. Editable files are capped at 4 MiB, directory traversal and watcher subscriptions are bounded, and cancellation
stops searches and event streams.

`ReadFile` returns bytes and their strong SHA-256 revision. `WriteFile` requires `expected_revision`, either the exact
lowercase 64-hex revision from the read or `missing` for create-only writes. Successful writes return the new revision;
stale writes return `ABORTED` with the current revision in `OperationFailure` details. A workspace lock serializes
revision comparison and mutation for Nanoagent API writers. Tengri preserves the public conflict response and revision.
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

The final OCI artifact carries a pinned boot kernel and a populated 1 GiB ext4 root disk under `/guest`. The Dockerfile
checks the populated filesystem with at least 16 MiB and 256 inodes free, then writes a SHA-256 manifest.
Regenerable Python bytecode caches and packaged documentation are omitted from the rootfs; Python source, libraries,
executables, and copyright files remain. Native image checks exercise Python SSL, SQLite, JSON, and virtual environments.
The check runs in a separate build stage and copies only its receipt into the image. Packaged manuals, translated
messages, and documentation other than copyright notices are omitted to keep the guest within that limit.
The image contains a minimal Ubuntu 24.04 shell environment, Nanoagent, and a
compressed multi-architecture bundle for the pinned Node 24.11.1, Bun 1.4.2, uv 0.11.14, Go 1.25.5, Rust/Cargo
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
C, and CGO projects therefore build from the persistent home toolchain without installing system packages.

`bootstrap-developer-tools` then installs Homebrew using a pinned, SHA-256-verified upstream installer. It uses
the PVC-backed `/home/nanoagent/.linuxbrew` prefix as the guest user, without sudo. This 26-byte prefix meets
[Homebrew's supported custom-prefix requirements](https://docs.brew.sh/Support-Tiers#custom-prefixes) on Ubuntu 24.04
for both AMD64 and ARM64. Homebrew verifies and installs binary bottles for Neovim, Tree-sitter CLI, GitHub CLI, fd, fzf, tmux, GNU Make,
CMake, pkgconf, and GCC with `g++`/`c++` commands. Existing Git, ripgrep, jq, SSH, curl, Python, and pinned language compilers remain available.
Successful installation writes a receipt tied to the bootstrap script, bundled Neovim configuration, XDG paths,
and resolved C toolchain root. A toolchain upgrade invalidates it so the C++ wrappers use the new headers and startup objects.
The cache also verifies that the C++ wrapper targets the active Homebrew compiler and sysroot.
Subsequent boots check that receipt and the supplied executables without starting Homebrew or Neovim. A missing
executable, changed configuration path, or new bootstrap invalidates the receipt and runs installation again.
The installer checks all baseline formulae in one Homebrew invocation. Neovim is upgraded when it is below
AstroNvim's required 0.11 minimum; other installed baseline formulae are reused.
Cold installation requires GitHub and Homebrew registry access and fails startup if installation or validation fails.

Nanoagent puts the pinned toolchain ahead of Homebrew in child-process PATH. Login shells use the image's
`/etc/profile.d/tengri-development.sh`, and newly created shell profiles source it too. Existing user shell profiles
and Neovim configuration are preserved. `EDITOR` and `VISUAL` default to `nvim` unless already configured. A new Neovim
configuration uses [AstroNvim's documented Lazy plugin setup](https://docs.astronvim.com/) with stable AstroNvim 6.1.0
and a pinned Lazy bootstrap. Its plugins are installed before Nanoagent becomes ready. Text icons work with the web
terminal's system monospace font. Run `nvim` to open the editor, `:AstroVersion` to inspect its version, and `:LspInstall`
or `:TSInstall` to add language support. Existing configurations remain user-owned. The default plugin setup runs when
the installation receipt is invalid, without upgrading installed plugins. Homebrew's Cellar, cache, and Neovim
configuration, plugin lockfile, plugin data, and undo files survive sleep/resume; none of these packages enters the 1 GiB rootfs.
Native image builds exercise this setup, all supplied commands, an additional `brew install hello`, and a repeated
bootstrap before the rootfs check. The cache regression replaces Homebrew and Neovim with failing executables and
proves that a prepared home still boots. Stale receipts, missing commands, changed XDG paths, and a changed toolchain root must run installation
and must not retain a successful receipt after a failure.

Small system compiler links let Homebrew's post-install steps reach the persistent C compiler at `/usr/bin/cc` and
`/usr/bin/gcc`. The C++ wrappers combine Homebrew's compiler and standard library with the bundled Linux development
headers and startup objects. Native validation compiles and executes a C++ program; the existing C and CGO checks
continue to use the pinned GCC 13.3.0 toolchain.

The guest's operating-system root filesystem is writable. The `nanoagent` user has passwordless `sudo` for guest
administration, including `sudo apt-get install`, system-file edits, mounts, and guest network configuration. The
guest has Linux administration capabilities inside the VM. The host VMM runs without capabilities, with Firecracker's
default seccomp filter, and with no host namespace or filesystem mounts in its Pod. Codex threads and turns use
`danger-full-access` inside the guest.

Nanoagent starts Codex with `gpt-6.1-sol` as its default model. Explicit thread and turn options override that default;
omitted options preserve an existing thread's settings.

The operating-system root is the private 1 GiB Firecracker disk. Snapshot sleep/resume retains its changes and running
processes. An explicitly fenced cold replacement resets the root from the image. The 16 GiB home, `/workspace`, Codex account, and
home-installed tools remain on the retained PVC. APT indexes and downloaded packages use `~/.cache/apt` on that PVC;
installed system packages consume root-filesystem space. Image builds exercise passwordless `sudo`, writes to `/etc` and
`/usr/local`, and a real `apt` package installation through `test-guest-admin.sh`. Run its `--runtime` mode in a
real guest through the isolated [KVM test](../tengri/test-kvm.sh) to exercise mounts and network administration.

On first boot, `bootstrap-codex` downloads the architecture-specific Codex 0.159.2 package from the npm registry,
verifies its pinned SHA-512 digest, and atomically installs the complete native package under the 16 GiB PVC-backed
`~/.tengri/codex` directory. Subsequent boots reuse that verified install. Nanoagent does not become ready until the
Codex app server is available. Preparing a vacant slot allows 35 minutes for language-toolchain, developer-tool,
and Codex cold installation, before any user can claim it. The language toolchain has a two-minute deadline, developer tools fifteen
minutes, and Codex nine minutes. Image builds run
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
# Requires Buf and the module's Go toolchain; generator versions are pinned in the script.
bash generate-proto.sh
bash -n bootstrap-codex.sh
bash -n bootstrap-toolchain.sh
bash -n bootstrap-developer-tools.sh developer-profile.sh
bash -n bootstrap-browser.sh bootstrap-browser-runtime.sh launch-browser.sh browser-xkbcomp.sh
bash -n validate-rootfs.sh validate-rootfs.test.sh
# On Linux with e2fsprogs and at least 1 GiB of temporary disk space:
bash validate-rootfs.test.sh
bash bootstrap-codex.sh --validate-manifest
gofmt -w *.go
go vet ./...
go test ./...
go test -race ./...
```

Use the wire interoperability test for local RPC validation. The production guest requires Linux vsock and the private
boot configuration injected by the slot runner. It has no alternate TCP development transport.

The Nanoagent workflow runs the focused Go validation. Tengri's image workflow then builds native `linux/amd64` and
`linux/arm64` Nanoagent images alongside the controller, publishes and keylessly signs
`registry.ide-newton.ts.net/lab/nanoagent` by immutable digest. CI publishes matching `kargo-sha-<source>` tags for the
controller and guest; the automatic Tengri Warehouse and Stage promote only the matched pair and pin both digests on
`kargo/tengri` for Argo reconciliation.

## VS Code workbench

Authenticated `OpenEditor` starts code-server on demand. `bootstrap-code-server.sh` pins version 4.135.0 and verifies
platform-specific SHA-256 digests before installing into `$HOME/.tengri/code-server`. The large upstream payload stays
on the persistent home volume, outside Firecracker's 1 GiB rootfs. Each image build verifies the native Linux archive;
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

See [the desktop acceptance runner](../../apps/landing/README.md#vs-code-in-the-desktop). Sleep and resume retain the
slot's image and live editor process. An image change requires the explicit fenced recovery procedure in
[the operations guide](../../docs/tengri/operations.md).

## Chrome and agent computer use

The guest runs a persistent headed Chromium browser with a private TigerVNC display. The desktop and Codex's
`computer` MCP tool share that display. The graphics runtime and engine install on the retained home with
checksummed package pins outside the enforced 1 GiB root filesystem. The boot init configures these browser paths
before starting Nanoagent and its Codex MCP server.
See [browser architecture and research](../../docs/tengri/browser.md).
