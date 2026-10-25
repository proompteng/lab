# landing web

This app expects the shared Convex backend in `packages/backend`.

Deployment: changes under `apps/landing/**` (or `packages/design/**`) merged to `main` trigger the main-branch image
build. The web image participates in the coordinated Ofz → Tengri → Proompteng release: matching source revisions
and schemas must pass all image and runtime qualification gates before promotion. A successful web build alone
does not establish deployment. Kargo discovers the immutable image set, creates Freight, and promotes the `proompteng` Stage; Kargo
writes the exact source commit, digest, and build/provenance metadata to `kargo/proompteng` without a pull request, and
Argo tracks that branch through sync/health. No Image Updater, SHA manifest bump, release branch, or deployment PR is
required. See [`docs/release-automation.md`](../../docs/release-automation.md) for the common delivery contract and
evidence commands.

## Local setup

1. Configure Convex once:

   ```sh
   bun run dev:setup:convex
   ```

   This prompts for or creates a Convex deployment and writes `packages/backend/.env.local`.

2. Copy the generated `NEXT_PUBLIC_CONVEX_URL` into `apps/landing/.env.local` (use the provided `.env.example` as a template).
3. If you want CMS-driven content, set `LANDING_CMS_URL` to your Payload instance (for example `https://cms.proompteng.ai`).
4. Seed the Convex models catalog once so the UI has initial data:

   ```sh
   bun run seed:models
   ```

5. Launch the Next.js app together with the Convex dev backend:

   ```sh
   bun run dev:landing
   ```

The homepage shows a “convex backend” badge once it can reach the Convex health check query.

## Tengri BFF development

The server-only BFF uses the dedicated Keycloak GitHub broker with PKCE S256 and required verified passkeys. Ofz
verifies the signed numeric GitHub identity, active platform membership and authentication level before returning an
opaque eight-hour session. Its hash and thirty-minute idle deadline live in shared SQL. Every request inspects that
session through exact SPIFFE mTLS. The browser never receives Kubernetes credentials or a guest bootstrap token.

The BFF's SQL pool serves only OAuth attempt creation and consumption. Five-minute attempts use one shared unlogged
PostgreSQL table, so sign-in does not wait for WAL or synchronous replication. Consumption remains atomic across BFF
replicas. A database crash or failover discards unfinished attempts and requires a fresh sign-in; it cannot authorize
a session. Sessions, policies, audits, replay protection, and capabilities remain durable. The BFF keeps its two-second
query deadline, verified database TLS, and existing attempt expiry and capacity limits.

`/access` and Settings → Access administer typed policies, quotas, scoped diagnostic grants and immutable receipts.
Workspace Viewers receive metadata only by default. Owners can explicitly approve selected file roots, conversation
and terminal IDs, screenshots and response budgets. Changing the workspace, collaborator, role or enabled state resets
the content opt-in. Scope fields validate canonical workspace paths, credential exclusions, IDs and UTF-8 byte limits
inline before submission; the BFF independently validates the same command. The full encoded command, including JSON
escaping and metadata, must fit the shared 64 KiB request budget. Developer assignments and removals cannot
carry a Viewer scope. The roster shows the exact approved targets and budgets, or `Metadata only` after scope removal.
Scope targets preserve their exact entered characters, including surrounding spaces; empty lines are ignored.
The roster labels file roots, Codex thread IDs and terminal IDs separately and quotes each target to make spaces
visible. Malformed Unicode that cannot survive protobuf encoding is rejected before submission.
Selected content can contain private information. Scoped guest content remains denied until the separate bounded
observer handlers are implemented and qualified.
The prepared identity release is held until the controller and every runtime channel complete the hard migration.
Workspace lifecycle operations use principal-scoped local storage and native Web Locks to coordinate desktop tabs.
A successful creation keeps its operation ID until that exact workspace is confirmed deleted, so a stale empty tab
recovers the same workspace instead of allocating another retained home. Uncertain outcomes retain the original
payload and ID; an explicit superseded response retires that operation. Browsers without Web Locks cannot submit
lifecycle changes.
Choosing a different creation name first replays the recorded request. An active workspace is recovered; a confirmed
terminal creation permits one fresh attempt with the new name. Denied or unavailable recovery preserves the original ID.
Deletion waits for Ofz's confirmed retained-home cleanup on both fresh requests and recovered operation IDs.
Pending cleanup or an unavailable authority returns an error and preserves those IDs for retry.
Deletion ignores failed status from an older policy version while waiting for its committed stop to reconcile.
The BFF rate-limits the authenticated GitHub subject. GitOps adds a separate Traefik rate-limit middleware that uses
Traefik's connection source, so the application never trusts caller-supplied forwarding headers for IP throttling.
The BFF also restores an in-progress Codex device login from the guest after a browser reconnect; it does not start a
replacement attempt or invalidate the code already shown to the user.

The internal gRPC connection requires SPIRE mutual TLS. The Proompteng Pod uses service account `proompteng` and a
read-only SPIFFE CSI socket. `SPIFFE_ID` selects its exact `spiffe://proompteng.ai/ns/proompteng/sa/proompteng`
identity; `TENGRI_SPIFFE_ID` pins `spiffe://proompteng.ai/ns/tengri/sa/tengri`. The server-only Workload API
client validates the URI, private-key match, validity window, and CA bundle before creating a TLS gRPC client.
Renewal creates a new client; existing streams retain their previous client until that certificate expires and then
reconnect with their event cursor. Before signing a request, the BFF reads that controller process's random audience
over the pinned mTLS channel. The v2 HMAC binds the audience, authenticated GitHub owner, session, method, payload,
runtime, deadline and recovery generation. A changed receiver rejects the request; the BFF does not replay it.
Missing, denied, malformed, or expired identity fails the request; there is no plaintext option. Local development
requires an attested SPIRE identity too. Native tests use a private fixture Workload API and real TLS certificates.

The desktop follows [Vercel's Geist typography](https://vercel.com/geist/typography): bundled Geist Sans for interface
text, portal menus, and diagrams, and Geist Mono for code and the terminal. Chat copy and primary labels use 14/20 px;
metadata uses 12/16 px, and code uses 13/18 px. Named copy, label, button, and heading utilities set size, line height,
weight, and spacing together. Fonts are self-hosted with `next/font/local`; source and license are in
[the font directory](public/tengri/fonts/README.md).
An explicit symbol fallback preserves monospace columns for glyphs Geist Mono does not contain, such as checkmarks.
The Codex view uses a near-black canvas, quiet zinc typography, and blue for primary actions. User messages sit on the
right with a soft background; agent responses stay on the left without speaker headings. A left sidebar (~240–260px) reads
the native paginated session index, with an active highlight and **New chat** control. Session menus provide **Archive**;
**Archived chats** provides **Restore**. Archive state survives reloads and is shared across browsers through the
retained native history. The browser-only session registry is removed; the selected ID remains `tengri-thread:${agentId}`. Saved history
loads behind a message-shaped skeleton instead of flashing the empty-conversation suggestions. The animation respects
reduced motion, and failures show the existing recovery controls. You can start or
switch conversations while another response runs or its submission is pending. Late thread creation and send replies
cannot replace the selected conversation or its draft; Stop remains bound to the selected conversation's run.
Text and image drafts, along with prompts waiting for their server
echo, remain with their conversation while the chat view stays open. Switching keeps sidebar rows in place, restores
the selected history, and focuses the composer when recovery completes. Pending approvals stay with their conversation,
including requests received while another conversation is selected; server resolutions and completed turns clear
both retained requests and visible controls. Notices remain attached to the conversation selected when they arrive,
including events queued before a switch, and adopt the server thread ID when a draft conversation is first created.
Chat and Finder recreate a permanently closed event stream with an exponential retry delay capped at thirty seconds.
A replacement chat stream starts at the latest received event cursor. Native browser reconnection remains active for
transient connection errors; closing the view cancels pending retries and ignores callbacks from retired streams.
The model catalog and saved-conversation startup retry temporary HTTP and network failures, with a delay capped at thirty seconds.
Successful recovery clears the catalog error and keeps the unsent draft. Permission and validation failures require
an explicit retry; recovery never submits or retries a turn. Closing chat or choosing another conversation cancels
the pending startup retry. Manual conversation recovery cancels the automatic request before taking over.
Catalog and conversation-history reads keep lifecycle controls available and are cancelled when a transition starts.
Browser cancellation propagates to the gRPC request. A rejected transition lets these reads recover without closing chat.
The event buffer bounds ordinary history while retaining pending approvals
until resolution or completion. Successful recovery clears the selected session's unavailable marker;
native metadata owns sidebar names and ordering. A matching completed native turn, including one recovered from history,
ends response activity even if a durable status poll is late. Cancellation keeps its Stopping state until cleanup is confirmed.
The header is
thin, with status as muted micro text (Ready / Working / Approval needed / Reconnecting). The header and composer have
no horizontal divider. The composer uses a soft rounded surface with model/reasoning controls beside a circular
send/stop button. Approval, model, and reasoning selectors share the same trigger and menu styles.
New selections use GPT-6.1 Sol with explicit High reasoning. Stored native-default selections reset to High; explicit
supported reasoning choices remain selectable. Composer height updates before paint, preserves scrolling within long drafts, and
observes width changes without restarting the observer on each keystroke. The empty state is a short line plus text-link
starters. Commands, output, diffs, and reasoning summaries expand from compact rows without outlined cards. Approvals
use a soft surface with a muted label and Approve / Deny actions. Accepted prompts stay in the transcript while waiting
for the server's message item; the canonical item replaces the local prompt without duplicating it. Streamed text
updates once per animation frame, unchanged message cards are memoized, and a stable content observer follows changes
without rebuilding on every chunk. Following stops when the reader scrolls upward, so a delayed scroll event after
content growth does not leave the viewport behind the response.
Paste PNG, JPEG, or WebP images into the composer to attach them. Previews have individual remove controls.
Image-only messages and active-turn steering work too. Limits are four images, 4 MiB per image, and 8 MiB total.
Messages appear immediately while the request runs. Failed sends restore the text and attachments for retry.
Open chat windows keep their event streams and model selection when another desktop window takes focus.
Recovered runtime restart notices disappear after a successful turn start or thread recovery; failed turns remain visible.
Images are stored in the retained workspace under
`/workspace/.tengri-attachments` and passed to Codex as local image inputs. Keep that folder to retain images referenced
by saved conversations.

Consecutive tools appear in compact, collapsible groups. Each row keeps its command or connector action and target;
expanding it shows arguments and results. Terminal output removes ANSI controls and decodes JSON string wrappers while
preserving columns. Conversation and tool-output scrollbars use a thin thumb with a transparent track.

Submitted messages and active turns share the same quiet Thinking animation. Usage shows the remaining weekly percentage and rounds credits up to a whole number. The
dock uses one flat zinc surface without backdrop blur or a bright top edge. Its surface and icons magnify, with labels
appearing without an opacity animation. Responses support Markdown tables, task lists, and code blocks with copy feedback. Fenced `mermaid`
blocks render as flowchart, sequence, and class diagrams and update as responses stream. Other diagram types and
diagrams with images or remote CSS resources keep their copyable source visible; invalid or incomplete diagrams do too.
Accepted types have explicit pre-layout resource checks. SVG sanitization and the existing CSP remain enforced.
The conversation follows new events while the reader is at the bottom. Reading earlier messages preserves the scroll
position until the reader chooses **Jump to latest**.

1. Set the Ofz endpoint, exact SPIFFE identity, TLS control database files and OIDC client secret file from `.env.example`.
2. Set `TENGRI_DESKTOP_ORIGIN` to the HTTPS desktop origin and `TENGRI_OIDC_ISSUER` to the dedicated realm. The issuer
   registers the exact `${TENGRI_DESKTOP_ORIGIN}/api/auth/callback`. The GitHub OAuth client registers the Keycloak
   broker callback documented in [`keycloak/tengri`](../../argocd/applications/keycloak/tengri/README.md).
3. Keep `TENGRI_PUBLIC_URL` as the separate browser/preview gateway origin. It is not the desktop authentication origin.
4. Start the Rust Tengri service against the isolated migrated control plane. Direct GitHub/Better Auth cookies and
   development HTTP authentication have been removed. Native tests use private TLS and Workload API fixtures.

Generate the schema-derived BFF authorization client from the repository root:

```sh
buf generate --template services/ofz/buf.gen.yaml --path proto/proompteng/authz
```

Changing `TENGRI_PUBLIC_URL` rolls the landing Deployment through GitOps. One surge Pod keeps a ready web endpoint
available while the replacement starts; existing streams reconnect when the old Pod terminates.
Merge the reviewed configuration, let Argo follow the Kargo deployment branch and replace the Pod, then verify
`kubectl --context galactic-lan -n proompteng rollout status deployment/proompteng --timeout=5m` and confirm an
authenticated `/api/tengri` snapshot reports the expected `previewGatewayOrigin`. Existing MicroVM Pods and PVCs are
not touched. Roll back an image by re-promoting the last known-good Proompteng Freight through Kargo; do not apply or undo
the Deployment directly.

Code keeps recoverable drafts scoped to the GitHub owner and agent creation identity. File reads include a SHA-256
revision; saves require that base revision and verify the returned revision. A competing API save returns a conflict
and preserves the local draft.

Finder, chat file links, image attachments, terminal working directories, and the Code bridge use canonical
`/workspace` paths. The signed request retains that path until the guest validates it and resolves it inside the
retained home. The BFF requires guest API version 7 in the controller's authenticated audience response before
signing a request. The controller verifies that version in the guest's identity response before forwarding operations.
Mixed release versions fail closed. The older virtual file
namespace is removed; upgrade retained guests with a fenced cold replacement before verifying this release.

Draft storage never evicts another unsaved edit to make room. When browser storage is unavailable or full, Tengri
keeps a temporary recovery copy and exposes a download on the desktop and lifecycle screens. A page-unload warning
remains active until those edits are saved or discarded. Temporary copies cannot survive a browser restart, so
download them before closing the tab if storage cannot be restored.

## Validation

### Desktop design and interaction

The Tengri desktop uses macOS-style unified toolbars, full-height sidebars, restrained window shadows, and a
proximity-magnifying Dock. Apple’s original Big Sur wallpaper and application artwork are bundled locally; provenance
is in [`public/tengri/README.md`](public/tengri/README.md). Finder, Chrome, Tengri, Code, Terminal, and Settings operate on the real guest workspace.
Chrome opens the guest's full Chromium browser. Tengri owns Codex chat and has its own generated Dock icon.
The agent's computer tool operates the same browser, with a human takeover control.
Browser approvals use a compact "Allow browser control?" card with request details available on demand. One-use,
session, and deny choices retain the scopes advertised by the request.
See [browser architecture and research](../../docs/tengri/browser.md).

Desktop, setup, and confirmation windows share their traffic-light controls: 14 px flat circles with 23 px between centers,
with colors and rounded hover glyphs matched to native macOS screenshots. Each retains a separate 24 px hit target.
Available actions show symbols on hover or keyboard focus; unavailable actions are gray and disabled.
Closing a confirmation cancels it, and its controls stay
disabled while the confirmed operation runs.

Window movement and Dock magnification update transforms without React state changes per pointer frame. Pointer
geometry is measured at gesture boundaries; app content is memoized independently from window placement. The clock
updates its own leaf component. Minimized windows retain their application sessions and finish their animation at the
corresponding Dock icon. Reduced-motion preferences update while the desktop is open.

Dock magnification reserves space between icons and expands its flat surface with transforms, using cached
geometry and limiting expansion at narrow viewport edges. Activating a window returns keyboard focus to its last
control; Terminal is ready for typing when opened. Minimize preserves the window's zoom state and normal bounds.
Maximized windows fill the desktop below the menu bar with square corners and no margins. The Dock hides until the
pointer reaches the bottom edge or a Dock control receives keyboard focus. Normal windows remain above the Dock.
The Window menu lists the active app's individual windows, identifies minimized windows, and marks the active window.

Finder's toolbar, sidebar proportions, row density, action menu, and icon view were compared directly with Finder
on macOS 26.5.2. The toolbar shows the current folder; Go to Folder opens a validated location dialog. Sortable
Name, Date Modified, Size, and Kind columns share their ordering with range selection. Breadcrumbs navigate the real
workspace, and the status bar reports selection counts. File mutations remain in the action menu with confirmation
before permanent deletion. The sidebar only advertises the available workspace.

Dock hit areas use transforms with fixed layout dimensions. Minimize and restore animate an explicit transform
through the browser's native animation API; drag translation stays independent. Browser coverage measures Dock
layout recalculations under 4x CPU throttling and verifies native transform keyframes and restored window geometry.

Design references: Apple [windows](https://developer.apple.com/design/human-interface-guidelines/windows),
[toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars), and
[materials](https://developer.apple.com/design/human-interface-guidelines/materials); web.dev
[animation performance](https://web.dev/articles/animations-guide).

`bun run test:e2e` covers toolbar alignment, narrow layouts, all resize corners, drag continuity, Dock magnification,
minimize targets, reduced motion, idle geometry reads, and guest lifecycle behavior. Visual snapshots are generated
with the pinned Playwright browser on both macOS and Linux.

The mocked desktop tests run independently with four workers in CI and two locally. CI builds the production desktop
once and serves it for both the mocked browser suite and real acceptance fixtures, avoiding a second development
compilation. The real editor fixture restores compiled Rust dependencies from a toolchain and dependency keyed cache.
PR browser validation uses hosted Ubuntu capacity instead of competing with native image builds on ARC.
Failure screenshots remain enabled; video and traces are recorded on the first retry instead of encoding discarded
videos for passing tests. Frontend-only PRs skip the VM image workflow; main still builds and validates the coordinated
Tengri and Nanoagent release pair.

```sh
cd apps/landing
bunx tsc --noEmit
bun run lint:oxlint
bun test src/lib/tengri
bun run build
```

## VS Code in the desktop

Code runs the upstream VS Code workbench through [code-server 4.135.0](https://github.com/coder/code-server/releases/tag/v4.135.0)
(Code 1.135.0) inside the user's Nanoagent guest. Explorer, tabs, search, Source Control, integrated terminals, language
servers, and extensions are native workbench features. Extensions use Open VSX; Microsoft Marketplace-only extensions
may not be available in this distribution. The old Monaco shell and its browser dependency have been removed.

The composer's **Approvals** selector offers **Ask first** and **Auto approve**. The browser remembers this per
workspace and automatically resolves advertised action confirmations while the chat is open. Questions remain manual:
native multi-question requests, supported primitive MCP forms and HTTPS URL confirmations render answer controls.
The signed guest response contract keeps typed answers separate from action decisions. Failed submissions preserve
the form for retry, and failed auto-approvals expose manual controls without an automatic retry loop.
Resolved approvals and answers stay retired for the open workspace, including across conversation changes. Older
run-status snapshots and replayed events cannot restore them. Automatic attempts also remain recorded across
navigation, so a failed automatic attempt requires a manual retry or an explicit approval-mode change.

Chat shows Starting, Connecting, Reconnecting and Stopping while a durable run changes state. Internal run reasons
stay out of these activity labels. Brief event-stream or run-status interruptions retry quietly. A connection warning
appears after three seconds of continuous interruption and clears after recovery. Authentication and permission
failures keep their original errors. A follow-up confirmed undispatched because its previous turn finished waits for
that exact run's terminal state, then submits the message once with a fresh operation identity. Uncertain dispatches
retain their original identity. An approval confirmed undispatched after its exact run finishes is removed without
approving another turn.

Accepted messages sent during a running turn remain visible through streaming and replay recovery. Live echoes
suppress duplicates; only a matching item in saved history retires the local accepted copy.

Local `/workspace/...` links in agent messages open file tabs above the conversation. The sidebar remains visible,
and switching back to Chat preserves the draft and running conversation. Markdown renders in the file tab; Source
shows numbered lines and highlights an optional `:line:column` or `#LlineCcolumn` reference. Other text files show source.
File reads use the authenticated file API, with loading, retry, and bounded previews. Web links still open externally.
Resource previews use the authenticated `stat-file` metadata lookup without enumerating siblings. Folder resources
open a directory listing, with child navigation, parent navigation,
an empty-folder state, and refresh. The workspace root and folder links with trailing slashes are supported.
Use the pin button in a resource preview to keep it in **Pinned** in the sidebar. Pins retain an
optional line and column and remain available after closing their tabs. Open a pin to restore that location, or
unpin it without closing the preview. Each window restores its own tabs and selected view after reload; workspace
pins are shared across windows. Selecting a session returns to Chat without closing resource tabs.
Tabs and pins each retain up to 20 resources. Persistence contains validated `/workspace` paths and locations only,
with no file contents or credentials. Restored inactive tabs do not read resources until selected. Deleting the workspace
clears its resource metadata along with its selected-session state.
Sent image attachments appear in user messages, including restored history. Agent replies render local workspace
PNG, JPEG and WebP images inline; generated-image tool outputs with saved workspace paths also show thumbnails.
Local image links can open image file tabs. Retained image reads use the authenticated,
owner-authorized file contract, validate raster signatures and size, and disable caching. Missing images show an
unavailable placeholder. Arbitrary remote Markdown images remain disabled.
Command output stays plain text: Markdown image examples in printed source or logs do not trigger image reads.

Finder's **Open in Code** sends a file-opening request through the owner-scoped gateway to a small guest extension using
VS Code's public API. The extension reports dirty tabs and uses native save/discard/cancel dialogs when closing a window.
Lifecycle changes are blocked while a window has unsaved edits or its save state is unknown. Settings and installed
extensions live in the persistent guest home; stable window origins preserve VS Code's workspace identity and native backups across reload.
Editor launches retain the backend's cold-start budget. Completed transient failures retry twice after one and two
seconds using the same window identity. Closing the window cancels its pending request through the editor RPC and
clears its retry timer; authorization denials
surface immediately, and exhausted retries expose the normal Retry control.
Code and Chrome renew their 30-minute preview leases halfway through the server-confirmed lifetime. A hidden
authenticated bootstrap refreshes the HttpOnly cookie on the existing window origin. Code remains mounted with its
unsaved buffers; Chrome keeps its display, form contents and takeover state. Existing sockets retain fresh Ofz
checks and the current bound lease. Rotated credentials cannot open new sockets. A renewal failure remains visible and
retry uses the same origin. Renewal neither launches guest processes nor bypasses a fresh Ofz decision.
Recoverable drafts from the previous editor remain available as downloads and never overwrite workspace files.
Sign-out first revokes the user's editor sessions, including those opened in other desktop tabs. If revocation fails,
the desktop keeps the user signed in and shows the error so they can retry.

Run the real integration test from the repository root:

```sh
bunx playwright install chromium
bash services/nanoagent/test-vscode-browser.sh
```

The runner requires Bun, Go, Rust, Node.js, OpenSSL, Python, Docker, and `protoc`. It starts the disposable TLS PostgreSQL
and SpiceDB fixture, migrates the shared runtime database and supplies separate controller/BFF database roles. It downloads
and verifies the pinned upstream release, starts real Nanoagent and Tengri gateway fixtures, and drives the actual workbench
through Chromium. Set `OFZ_FIXTURE_SSH` to use the authorized remote Docker host for the database. Provisioning and identity
are local fixtures; editor files, terminals, WebSockets, cookie exchange, and CSP use their production implementations.
Ports 8080, 13338, 3143, 18082, 18083, and 3443 must be free. Logs are retained under `/tmp/tengri-vscode.*`.
The local TLS proxy and isolated test certificate exercise secure cookies, WebSockets, and the production CSP without
weakening application policy. To test an existing production build, set `TENGRI_EDITOR_NEXT_MODE=start`.
Docker browser fixtures reset their disposable Chromium profile for each run and retain the installed engine cache.
The verified release is cached under `node_modules/.cache/tengri-code-server`; `TENGRI_EDITOR_INSTALL_HOME` can select
an existing installation cache without reusing a test workspace.

Tengri error reporting uses the existing private GlitchTip service, with a bounded same-origin browser error tunnel.
Next instrumentation initializes manual OTLP request tracing and error-only Sentry SDK reporting. Public runtime
configuration contains only the ingest DSN and immutable release. See the
[Tengri observability contract](../../services/tengri/README.md#error-reporting-and-request-traces) for privacy,
network policy, rollout and actual collector verification. The landing test command includes SDK export, envelope
validation, stream limits and content-scrubbing checks.

Chat file links display absolute `/workspace/...` guest paths and translate them to workspace-relative file API
paths for text and image reads. Switching file tabs retains loaded contents and the Source/Rendered view without
refetching; reopening an existing file preserves tab order. A failed inline image offers an explicit retry.

Desktop preview startup and lease renewal keep retrying transient network, timeout, rate-limit and server failures,
with a maximum 30-second backoff. Authentication and authorization failures stop retries. The Chrome display
reconnects its own transport without reloading the retained browser document.
