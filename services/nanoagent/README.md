# Nanoagent guest API

The guest includes [dormant Relay support](../../docs/tengri/relay-staged-rollout.md).
Its connector handlers require the exact server-side setting
`TENGRI_CONNECTORS_ENABLED=true`; the default denies calls before creating
identity files or changing Codex configuration. Packaging the client does not
install a connector or change normal conversation startup.

`internal/guestauth` implements the mandatory protocol 4 signature contract for the Ofz migration. Its admission helper
verifies the exact request and runtime bindings before atomically consuming a bounded nonce entry. Diagnostic agent
proofs require an explicit observation budget and cannot carry control actions. Workload proofs permit only an exact
metadata probe or terminal cleanup. The shared public test vectors are generated together into the Tengri fixture and
`internal/guestauth/testdata/ofz-guest-request-v4.json`. Go embeds its copy in the test binary so standalone Docker
builds and isolated test execution do not require a sibling source directory. CI verifies both generated copies.
These public deterministic keys must never provide deployment keys.

Ofz checks the complete approved policy on each call. The signed proof delegates one exact action, method, target and
body with only that request's byte/item budget; it does not copy file roots or unrelated conversation/terminal IDs into
the guest. The 16 KiB decoded-context limit covers JSON escaping of a maximum 4096-byte target. Protocol 3 and its
signing domain are rejected. Controller, supervisor and guest must migrate together.

The RPC receiver requires a signed proof for every unary request and every stream opening message. It checks the
canonical protobuf bytes, action, target, exactly one copy of each claim header, and the runtime published by guest
root before admitting a single-use nonce. It rechecks the runtime before returning unary data or sending stream data.
The bootstrap token alone grants no RPC admission. Scoped content is denied until the bounded observer RPCs exist.

Guest init requires a 32-byte public `verificationKey` in the private slot boot configuration. It publishes the key as
`/run/tengri/guest-verify.pub` and atomically writes `/run/tengri/claim.json` after binding a resumed runtime. Freeze and
resume clear the previous claim. Nanoagent reads bounded root-owned regular files and rejects writable files and
symlinks. The host runner mounts only `tengri-guest-verification`, never the controller's private signing key.
Controller signing, supervisor proof/shared replay checks and preview authorization use the same mandatory protocol.
Native KVM acceptance, independent execution fencing, observers and recovery remain migration gates; this checkpoint
cannot be deployed.

Nanoagent runs as UID 1000 inside each Tengri Firecracker guest. Tengri owns the VMM outside the guest, in a normal OCI
slot Pod. The guest has its own Linux kernel, root disk, and retained 32 GiB home. See the
[runtime lifecycle](../tengri/README.md) for the host boundary and snapshot protocol.

The guest `guest-init` helper reads the runner's private boot configuration, mounts the home, and starts Nanoagent as
UID 1000. It passes the slot credential through a one-use anonymous pipe, with a sanitized child environment.
Nanoagent disables Linux dumpability, closes the pipe after
reading it, and never returns, hashes into public metadata, or logs the credential. Public health probes remain
unauthenticated.

Guest preparation also starts one private UID 1000 shell on a PTY for lifecycle readiness. Each ready or resume hook
checks initialized Nanoagent/Codex, reads the retained workspace, and exchanges a fresh challenge with that same shell
within one second. The shell and PTY survive in the snapshot; restore does not fork another readiness process.
Unexpected output, an exited shell, or a timeout fails closed and reaps the probe. This private probe does not consume
a user terminal session. Native acceptance still exercises real guest files, the user's retained PTY, and Codex RPCs.

The Chrome display reconnects a dropped VNC transport against the same authenticated preview origin, with eight
backoff attempts over at most 121 seconds. It retains the guest Chromium process, tabs and form input. VNC security
failures stop immediately; closing the viewer cancels any retry without reporting an application error.

## Current API

Tengri uses `proompteng.runtime.guest.v1.NanoagentService` from the shared
[`nanoagent.proto`](../tengri/proto/proompteng/runtime/guest/v1/nanoagent.proto). Guest API protocol 8 adds `StatFile`,
which reads one path's metadata without listing its siblings. It uses the existing file-observation authority and
workspace confinement. The controller rejects older guest API versions; roll out the paired controller and guest
images together. The signed Ofz request protocol remains version 4. Nanoagent serves HTTP/2 gRPC and preview
HTTP over private vsock port 1024. Every RPC checks the slot's unique bootstrap credential. Only the host supervisor
can reach this transport, after authenticating the exact Tengri SPIFFE identity and current owner/epoch headers.
The binding includes the Ofz runtime epoch. Guest init requires that canonical epoch on every resume and returns its
complete claim to the runner. It can change the runtime only from a frozen snapshot belonging to the same MicroVM UID
and slot epoch; an active guest cannot be rebound. The runner rejects a resume reply that omits or changes that claim.
Port 8080 binds guest loopback and serves health probes. Host mTLS terminates at the supervisor on port 8443.

SPIRE credentials and its CSI socket stay in the host supervisor. Guest memory contains no SVID, PSAT token, Kubernetes
token, or host Workload API socket. Certificates can rotate while the guest sleeps. The guest administrator can control
the guest, including its bootstrap credential, but cannot authorize another slot or call host lifecycle endpoints.

The service covers editor startup, bounded file discovery and atomic mutations, PTY lifecycle, Codex calls and
approvals, file/Codex server streams, and a bidirectional terminal stream. File content travels as protobuf bytes.
Codex's independently versioned JSON parameters, results, and events travel as bytes inside typed protobuf envelopes;
this preserves numeric IDs and the pinned app-server schema. Browser terminal framing is translated by Tengri.

Tengri authenticates directly to `GetInfo` and verifies the MicroVM identity and guest API version 7. This version
requires confirmed command cleanup before cancellation, stable operation UUIDs, and canonical `/workspace` paths
for file operations, file events, and terminal working directories. The BFF
requires that version in the controller's existing authenticated audience response before signing a request. The signed
target stays unchanged through admission; only the confined filesystem translates it into the retained home. A real
directory named `workspace` is addressed as `/workspace/workspace`. Legacy virtual paths such as `/lab/README.md`
are rejected. The request-signature contract remains version 4. Old guests fail the identity check before file
operations and need a fenced cold replacement on their existing retained home. Guest control is
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
ready, and restarts failed processes with bounded backoff. Successful initialization publishes a replayable
`tengri/runtimeReady` event with the process generation. A new process has not loaded retained conversations. When
`turn/start` receives the exact native `thread not found` rejection, Nanoagent resumes that same conversation and
repeats the unaccepted operation once, fenced to the rejecting process generation. Other errors and uncertain
dispatches are never retried this way. The stable operation receipt still prevents duplicate accepted turns.
The chat clears earlier restart notices on this event,
without requiring another user turn. Its authenticated `GetInfo` metadata reports whether Codex
is working across any conversation and the monotonic time since work ended. Starts and steering remain active while
awaiting a response even if the caller disconnects; turn/status notifications and process generations settle work state.
Pending approvals also inhibit automatic sleep. No event subscriber is required, and metadata probes do not reset the
idle timer. Incomplete work state is reported as unavailable so Tengri defers automatic sleep. Every Codex call response includes the event sequence
captured atomically when its app-server response is received, so thread snapshots can be reconciled with independently
delivered event streams without duplication. Device login and thread state persist under the private PVC-backed
`.codex` directory. Events and approvals are typed, bounded, and replayable after reconnect; Nanoagent does not inject
a shared `OPENAI_API_KEY`.

Tengri disables the inherited ChatGPT app catalog with `features.apps=false` at Codex startup and on every thread
start or resume, including automatic recovery after a native process restart. This excludes remote execution apps
such as `agents_shell` from the default tool set. Native shell, file editing, Git, and repository setup run inside
the guest's retained `/workspace`. The explicitly configured Tengri browser and Relay MCP servers remain separate
from the ChatGPT app catalog. This default is not a network sandbox; the guest administrator retains full guest access.

Native `turn/interrupt` can leave yielded `exec_command` sessions running. Nanoagent records each command item ID
from the accepting process generation's ordered turn and item notifications. An interrupted turn retains its work
inhibitor while Nanoagent inventories native background terminals, terminates only that turn's command items, and
confirms their absence. Earlier turns' intentional background commands remain running. Cleanup retries stay bound
to the accepting generation. Missing ownership or an ended generation requires reconciliation and never authorizes
cleanup against a replacement process. Terminal receipt version 2 records `processesStopped: true` only after this
confirmation; old receipts and unconfirmed interrupted history cannot release a durable run's workspace or sleep pin.

Native user-input questions and supported primitive MCP forms/HTTPS URL elicitations are retained as pending input
requests. `CodexCall` method `tengri/resolveApproval` delivers identified controls through a durable receipt and the same
generation-fenced reply path. Approval IDs include a random process identity; native request ID reuse cannot revive
an approval card after process replacement.
The guest validates original question IDs, advertised choices, required fields, types and supported constraints before
replying. An action decision cannot resolve an input request, and an input payload cannot resolve an action approval.
Unsupported and oversized question schemas still fail explicitly without fabricating a user answer.

The allowed Codex calls include account, model, conversation and turn operations, and read-only MCP server status
for verifying the browser computer tool.
Session discovery and archiving use the pinned native `thread/list`, `thread/archive`, and `thread/unarchive` APIs.
Archiving retains the session's history. It shares the native operation mutex with turn admission and rejects an
active turn before calling the app-server. The controller also rejects archiving a session with an unfinished durable run.

## Firecracker rootfs and persistent tools

The final OCI artifact carries a pinned boot kernel and a populated 1.5 GiB ext4 root disk under `/guest`. The Dockerfile
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
for both AMD64 and ARM64. Homebrew verifies and installs binary bottles for GitHub CLI, fd, fzf, lazygit, gdu, bottom, kubectl, tmux, GNU Make,
CMake, pkgconf, and GCC with `g++`/`c++` commands. Existing Git, ripgrep, jq, SSH, curl, Python, and pinned language compilers remain available.
Successful installation writes a receipt tied to the bootstrap script, bundled Neovim configuration, XDG paths,
and resolved C toolchain root. A toolchain upgrade invalidates it so the C++ wrappers use the new headers and startup objects.
The cache also verifies that the C++ wrapper targets the active Homebrew compiler and sysroot. Homebrew's `gdu-go`
executable is linked as `gdu` on the guest PATH for AstroNvim.
Subsequent boots check that receipt and the supplied executables without starting Homebrew or Neovim. A missing
executable, changed configuration path, or new bootstrap invalidates the receipt and runs installation again.
The installer checks all baseline formulae in one Homebrew invocation and reuses installed formulae.
Cold installation requires GitHub and Homebrew registry access and fails startup if installation or validation fails.

Nanoagent puts user executables first, then the local editor and pinned toolchain ahead of Homebrew in child-process PATH. Login shells use the image's
`/etc/profile.d/tengri-development.sh`, and newly created shell profiles source it too. Existing user shell profiles
and Neovim configuration are preserved. The profile exports the fixed Homebrew prefix and paths directly, so opening
a terminal does not start Homebrew. `EDITOR` and `VISUAL` default to `nvim` unless already configured.

The managed editor lives on the fast guest root at `/opt/tengri/editor`: SHA-256-pinned Neovim 0.12.5,
Tree-sitter CLI 0.27.1, Lazy, AstroNvim 6.1.0 at commit `aa0545fc8357009fc8a67e6cd93e7f8544e3aba9`, every baseline plugin,
Blink's native completion library, and nine baseline parsers. AstroNvim uses its exact commit because the upstream
moving minor tag `v6.1` also matches Lazy's `v6.1.0` version range. Build and offline runtime checks verify the installed commit.
The image build installs and verifies these dependencies; opening a fresh editor downloads nothing.
The build verifies Blink's release checksum and packages its library without downloader state, following
Blink's [manual-install contract](https://cmp.saghen.dev/configuration/fuzzy).
The bundled loader resolves this verified library before Git discovery. The offline image test denies Blink's Git
version queries and still requires native completion within one second.
The generated manifest points Lazy directly to these local plugin directories. Automatic plugin updates,
missing-plugin installation, completion-library downloads, and parser downloads are disabled for the managed baseline. The offline
image test loads completion and requires its bundled Rust implementation. Explicit `:TSInstall`
and user-added plugins can still use persistent user storage. Run `nvim` and `:AstroVersion` to inspect the editor.

Existing user shell profiles and edited Neovim configuration are preserved. On an image update, bootstrap replaces
an unchanged generated configuration only when its hash and path match the previous receipt. Custom plugins,
Homebrew's Cellar and cache, editor data, lockfiles, state, undo files, workspace and Codex state stay on the retained
home PVC. The launcher moves only regenerable Lua bytecode caches to the guest's local `/tmp`; it does not move or
remove user data. Existing Homebrew Neovim installations remain available explicitly. User `~/.local/bin` overrides
retain priority over the managed editor.

The browser terminal serves Nerd Font symbols alongside Geist Mono and renders block, bar, and underline mode
cursors. Guest fonts are unnecessary. Native image builds exercise the supplied tools, an additional `brew install hello`,
and repeated bootstrap. A separate network-disabled check starts the managed editor twice with fresh XDG directories,
verifies all baseline plugins and parsers resolve locally, and opens a custom persistent plugin fixture. Bootstrap's cache
regression replaces Homebrew with a failing executable and proves that a prepared home still boots. Stale receipts,
missing commands, changed XDG paths and a changed toolchain root must invalidate installation and must not retain a
successful receipt after failure. These headless checks establish dependency availability; terminal first-screen latency
is measured separately on a real guest.

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

The operating-system root is the private 1.5 GiB Firecracker disk. Snapshot sleep/resume retains its changes and running
processes. An explicitly fenced cold replacement resets the root from the image. The 32 GiB home, `/workspace`, Codex account, and
home-installed tools remain on the retained PVC. APT indexes and downloaded packages use `~/.cache/apt` on that PVC;
installed system packages consume root-filesystem space. Image builds exercise passwordless `sudo`, writes to `/etc` and
`/usr/local`, and a real `apt` package installation through `test-guest-admin.sh`. Run its `--runtime` mode in a
real guest through the isolated [KVM test](../tengri/test-kvm.sh) to exercise mounts and network administration.

On first boot, `bootstrap-codex` downloads the architecture-specific Codex 0.164.0 package from the npm registry,
verifies its pinned SHA-512 digest, and atomically installs the complete native package under the 32 GiB PVC-backed
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
# On Linux with e2fsprogs and at least 2 GiB of temporary disk space:
bash validate-rootfs.test.sh
bash bootstrap-codex.sh --validate-manifest
gofmt -w *.go
go vet ./...
go test ./...
go test -race ./...
```

Use the wire interoperability test for local RPC validation. The production guest requires Linux vsock and the private
boot configuration injected by the slot runner. It has no alternate TCP development transport.

Tengri's image workflow owns Nanoagent's protobuf generation, Go race tests, vet, rootfs, and bootstrap validation in
one job. It builds native `linux/amd64` and `linux/arm64` Nanoagent images alongside the controller, publishes and keylessly signs
`registry.ide-newton.ts.net/lab/nanoagent` by immutable digest. CI publishes matching `kargo-sha-<source>` tags for the
controller and guest; the automatic Tengri Warehouse and Stage promote only the matched pair and pin both digests on
`kargo/tengri` for Argo reconciliation.

## VS Code workbench

Authenticated `OpenEditor` starts code-server on demand. `bootstrap-code-server.sh` pins version 4.135.0 and verifies
platform-specific SHA-256 digests before installing into `$HOME/.tengri/code-server`. The large upstream payload stays
on the persistent home volume, outside Firecracker's 1.5 GiB rootfs. Each image build verifies the native Linux archive;
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
bundle is absent from the standalone release. Existing user settings are preserved. Each editor process starts with
the upstream `--disable-workspace-trust` switch, so opening folders does not prompt for trust or restrict terminals,
tasks, debugging, or workspace extensions inside the guest.
The upstream optional `vsda` browser assets are absent from this open-source distribution; their 404s do not disable the
workbench. Acceptance tests exercise TypeScript diagnostics to detect actual language-extension failures.

Guest initialization sets `fs.inotify.max_user_watches=524288` for large workspaces. Native KVM acceptance verifies
the running guest's limit. It also assigns the local hostname `tengri` and its loopback host entry so guest `sudo`
resolves its own hostname. These settings do not change the host or storage configuration.
An already running retained guest needs the same setting applied with its existing guest administrator authority;
ordinary image promotion preserves that guest's processes and kernel state.

See [the desktop acceptance runner](../../apps/landing/README.md#vs-code-in-the-desktop). Sleep and resume retain the
slot's image and live editor process. An image change requires the explicit fenced recovery procedure in
[the operations guide](../../docs/tengri/operations.md).

## Chrome and agent computer use

The guest runs a persistent headed Chromium browser with a private TigerVNC display. The desktop and Codex's
`computer` MCP tool share that display. The immutable image bundles a compressed graphics archive inside the
enforced 1.5 GiB root filesystem. Its expanded libraries and pinned Chromium build install on the retained home.
The boot init configures these browser paths before starting Nanoagent and its Codex MCP server.
The launcher sets `browser.custom_chrome_frame=false` on every start and disables Openbox decorations. Tengri owns
the window controls; Chromium keeps its tabs and address bar without a second set of controls inside the preview.
It hides the noninteractive testing banner with Chromium's documented `--disable-infobars` switch and disables
memory usage in tab hover cards. Interactive browser prompts remain available.
Computer-tool screenshots use the guest's temporary filesystem and are removed after encoding, so a full retained
home does not prevent screen capture. Codex transcripts, browser profiles, tools, and workspace files still share
the retained home and require free space there.
Desktop replay replaces tool-result image payloads with `[Image output]` before enforcing its byte limit. The tool's
identity, completion status, text, and structured result remain available; Codex receives the full original image.
See [browser architecture and research](../../docs/tengri/browser.md).

Nanoagent exports OTLP request spans and sanitized GlitchTip errors when the host supplies telemetry configuration
through the private boot file. It preserves W3C trace parents and reports gRPC failures as well as HTTP 5xx responses.
The HTTP wrapper preserves flushing and WebSocket upgrades. Errors retain their class, stack and trace ID; request
content, credentials, user context and variable values are removed. See
[Tengri observability](../tengri/README.md#error-reporting-and-request-traces) for the collector allowlist and deployment
verification. A new guest root is required to install this SDK; an existing snapshot retains its original process.
The root lifecycle helper and unprivileged API export separate `tengri.component` values. Lifecycle spans join the
host control trace and time clock synchronization, claim updates, filesystem freeze/thaw, API readiness, workspace
access and the terminal round trip. Slow or failed lifecycle phases also record their duration in structured logs.
Readiness failures remain failed spans without creating routine GlitchTip incidents. Platform collector settings are
excluded from user subprocess environments.
