# Nanoagent guest API

Nanoagent is the unprivileged guest process inside every Tengri `kata-fc` microVM. It is not a Kubernetes controller,
AgentRun runtime, privileged launcher, or node daemon. The Rust Tengri control plane is its only caller.

The process requires `MICROVM_ID` and a bootstrap-only `MICROVM_BOOTSTRAP_TOKEN`. Before starting any API or terminal,
the short-lived container entry process passes that credential through a one-use anonymous pipe and replaces itself
with a clean-environment Nanoagent process. The long-lived process disables Linux dumpability, closes the pipe after
reading it, and never returns, hashes into public metadata, or logs the credential. Public health probes remain
unauthenticated.

## Current API

Tengri uses `proompteng.runtime.guest.v1.NanoagentService` from the shared
[`nanoagent.proto`](../tengri/proto/proompteng/runtime/guest/v1/nanoagent.proto). Nanoagent serves authenticated gRPC
over HTTP/2 with SPIRE mutual TLS on port 8443. Each unary and streaming RPC also checks the per-MicroVM bootstrap
credential in `authorization` metadata. Port 8080 serves only unauthenticated health probes and cannot dispatch RPCs
or previews. No Talos machine configuration or service mesh change is required.

Nanoagent supervises SPIRE 1.15.3 inside the Firecracker guest. Its `galactic-guests` PSAT agent is attested with a
Pod-bound token for audience `spire-server`; its workload selector is Unix UID 1000. The issued identity includes the
current Pod UID. It connects to `spire-server.spire-server.svc.cluster.local:443`; the Kubernetes Service forwards that
connection to the SPIRE Pod's listener on port 8081. The TLS listener accepts only
`spiffe://proompteng.ai/ns/tengri/sa/tengri`; the controller pins
the guest's exact `spiffe://proompteng.ai/ns/tengri/nanoagent/pod/<Pod UID>` identity. The Go SPIFFE source watches
certificate and bundle updates, so new connections use renewed credentials without restarting Nanoagent.

The agent binary is installed under the persistent home from a versioned, SHA-256-pinned musl release archive. Build
stages verify both the native binary and the generated agent configuration. Only the installer and version receipt
enter the 1 GiB rootfs. Agent keys, attestation token, and data remain in private `/tmp/nanoagent-spire` files.
Tengri refreshes the token and public bundle over mTLS; the refresh RPC rejects another Pod UID and private material
in place of CA certificates. Terminal and Codex children receive no SPIFFE or SPIRE configuration variables. A guest
administrator owns that guest's identity; its Pod-bound parent cannot attest another guest or the controller.

The service covers editor startup, bounded file discovery and atomic mutations, PTY lifecycle, Codex calls and
approvals, file/Codex server streams, and a bidirectional terminal stream. File content travels as protobuf bytes.
Codex's independently versioned JSON parameters, results, and events travel as bytes inside typed protobuf envelopes;
this preserves numeric IDs and the pinned app-server schema. Browser terminal framing is translated by Tengri.

Tengri authenticates directly to `GetInfo` and verifies the MicroVM identity and protocol version. Guest control is
gRPC-only: the former REST, NDJSON event streams, and terminal WebSocket endpoints have been removed. There is no
HTTP discovery, negotiation, or fallback. Guests without this protocol must sleep/resume with the current image.
Controller and guest releases must use a compatible protobuf contract; an older HTTP-only controller cannot operate
this guest.

HTTP remains for process probes and application content:

- `GET /livez`, `GET /readyz`, and `GET /healthz`: process probes on plain port 8080;
- `/v1/preview/{port}/{path...}`: mTLS-authenticated HTTPS and secure WebSocket proxying on port 8443 to an allowed loopback application or VS Code.

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

The guest's first filesystem layer contains the complete rootfs and starts a fresh OCI chain. Containerd's
Firecracker snapshotter copies the persistent scratch rather than an existing 512 MiB Ubuntu parent. Prepare only the approved canary host's
scratch for 1 GiB; existing snapshots, metadata and homes stay intact. Normal promotion still requires every
eligible scheduling target to have sufficient scratch capacity. The Dockerfile enforces
a real 1 GiB ext4 population and filesystem check, with at least 16 MiB and 256 inodes left for extraction overhead.
Regenerable Python bytecode caches and packaged documentation are omitted from the rootfs; Python source, libraries,
executables, and copyright files remain. Native image checks exercise Python SSL, SQLite, JSON, and virtual environments.
The check runs in a separate build stage and copies only its receipt into the image. Final-image CI verifies a
parentless layer, unchanged runtime configuration and source filesystem ownership, modes, symlinks and capabilities.
Packaged manuals, translated
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

At image build time, `install-developer-tools.sh` installs Homebrew using a pinned, SHA-256-verified upstream installer. It uses
the PVC-backed `/home/nanoagent/.linuxbrew` prefix as the guest user, without sudo. This 26-byte prefix meets
[Homebrew's supported custom-prefix requirements](https://docs.brew.sh/Support-Tiers#custom-prefixes) on Ubuntu 24.04
for both AMD64 and ARM64. Homebrew verifies and installs binary bottles for Neovim, Tree-sitter CLI, GitHub CLI, fd, fzf, tmux, GNU Make,
CMake, pkgconf, and GCC with `g++`/`c++` commands. Existing Git, ripgrep, jq, SSH, curl, Python, and pinned language compilers remain available.
The image includes compressed Homebrew and AstroNvim seeds outside the mounted home. `bootstrap-developer-tools`
verifies and extracts these local files into the PVC as UID 1000, filling missing files without replacing existing
files, symlinks, ownership, or directory modes. A completed seed receipt avoids repeated Homebrew extraction.
Boot checks the supplied commands and Neovim's required 0.11 minimum without running Homebrew, Lazy, or Mason installers.
Incomplete or incompatible tools fail startup; no network installation fallback is attempted.
The build retains Homebrew's exact manager checkout and current tag in a shallow repository, omitting old history
and reflogs. It verifies unchanged runtime-file hashes, manager/package versions, and `brew doctor` before packaging.

Nanoagent puts the pinned toolchain ahead of Homebrew in child-process PATH. Login shells use the image's
`/etc/profile.d/tengri-development.sh`, and newly created shell profiles source it too. Existing user shell profiles
and Neovim configuration are preserved. `EDITOR` and `VISUAL` default to `nvim` unless already configured. A new Neovim
configuration uses [AstroNvim's documented Lazy plugin setup](https://docs.astronvim.com/) with stable AstroNvim 6.1.0
and a pinned Lazy bootstrap. Its plugins and native build steps are completed during image creation. Text icons work with the web
terminal's system monospace font. Run `nvim` to open the editor, `:AstroVersion` to inspect its version, and `:LspInstall`
or `:TSInstall` to add language support. Existing configurations, lockfiles and plugin data remain user-owned.
The default configuration and matching plugin seed are supplied only when no Neovim/Vim configuration exists,
including custom XDG locations. Homebrew's Cellar, cache, and Neovim configuration, plugin lockfile, plugin data,
and undo files survive sleep/resume; only compressed seeds enter the 1 GiB rootfs.
Native image builds exercise this setup, all supplied commands, an additional `brew install hello`, and offline
clean-home, existing-home and restart checks before the rootfs check. PR image verification repeats these checks
with networking disabled and an empty home mount, so baked home files cannot mask a missing seed.
If the 1 GiB capacity gate fails, the build fails and produces no final image or validation receipt.

Small system compiler links let Homebrew's post-install steps reach the persistent C compiler at `/usr/bin/cc` and
`/usr/bin/gcc`. The C++ wrappers combine Homebrew's compiler and standard library with the bundled Linux development
headers and startup objects. Native validation compiles and executes a C++ program; the existing C and CGO checks
continue to use the pinned GCC 13.3.0 toolchain.

The guest's operating-system root filesystem is writable. The `nanoagent` user has passwordless `sudo` for guest
administration, including `sudo apt-get install`, system-file edits, mounts, and guest network configuration. The
controller allows privilege escalation, grants the guest Linux capabilities, and leaves guest syscalls unconfined
inside the `kata-fc` VM. The Pod has no host namespace or host filesystem mounts, and no Kubernetes service-account
token. Codex threads and turns use `danger-full-access` inside this same guest.

Nanoagent starts Codex with `gpt-6.1-sol` as its default model. Explicit thread and turn options override that default;
omitted options preserve an existing thread's settings.

The operating-system root remains the 1 GiB Firecracker image filesystem. Its changes are ephemeral;
container recreation, sleep/resume, or guest replacement restores the image. The 16 GiB home, `/workspace`, Codex account, and
home-installed tools remain on the retained PVC. APT indexes and downloaded packages use `~/.cache/apt` on that PVC;
installed system packages consume root-filesystem space. Image builds exercise passwordless `sudo`, writes to `/etc` and
`/usr/local`, and a real `apt` package installation through `test-guest-admin.sh`. Run its `--runtime` mode in a
Linux container with the guest capability and seccomp settings to also exercise mounts and network administration.

Image creation downloads and verifies the pinned Codex 0.159.2, code-server 4.135.0, and SPIRE 1.15.3 packages using
`fetch-runtime-tools.sh`. Complete Codex/code-server packages and the SPIRE agent are recompressed into checked local
seeds outside the mounted home. On first boot, the helpers verify and extract those seeds atomically into the
16 GiB PVC-backed home. Existing versioned installations and user settings are reused. No boot/workspace helper
runs a package downloader; a missing or corrupt image seed fails startup. Nanoagent does not become ready until the
Codex app server is available, and the `MicroVM` startup probe allows 35 minutes for SPIRE, language-toolchain,
developer-tool seeding, and Codex cold installation. The language toolchain has a two-minute deadline, developer tools two
minutes, and Codex nine minutes. Image builds run
the same bootstrap with networking disabled against the image-baked packages, so a bad checksum or package layout
fails CI before publication. Nanoagent invokes the installer only after its bootstrap credential has moved through the
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
bash -n bootstrap-developer-tools.sh install-developer-tools.sh compact-developer-tools.sh test-developer-tools.sh developer-profile.sh
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

Authenticated `OpenEditor` starts code-server on demand. `bootstrap-code-server.sh` pins version 4.135.0 and verifies
the image seed before installing into `$HOME/.tengri/code-server`. The complete installed payload stays on the
persistent home volume; its compact seed lives in the 1 GiB rootfs. Image creation verifies the upstream SHA-256
and native package. First use and retained-home resume work without package-download access.

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
