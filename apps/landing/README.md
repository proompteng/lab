# landing web

This app expects the shared Convex backend in `packages/backend`.

Deployment: changes under `apps/landing/**` (or `packages/design/**`) merged to `main` trigger the main-branch image
build. Kargo discovers the immutable image, creates Freight, and automatically promotes the `proompteng` Stage; Kargo
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

The server-only BFF uses stateless Better Auth GitHub OAuth and signed internal gRPC metadata. The browser never
receives Kubernetes credentials, the internal HMAC secret, or a guest bootstrap token.
The BFF rate-limits the authenticated GitHub subject. GitOps adds a separate Traefik rate-limit middleware that uses
Traefik's connection source, so the application never trusts caller-supplied forwarding headers for IP throttling.
The BFF also restores an in-progress Codex device login from the guest after a browser reconnect; it does not start a
replacement attempt or invalidate the code already shown to the user.

1. Set the Better Auth, GitHub OAuth, gRPC endpoint, HMAC, and `TENGRI_PUBLIC_URL` variables from `.env.example`.
   The public URL must match the Rust controller and is exposed to the browser only as the allowlisted preview gateway
   origin. HTTPS is required except for the exact `http://localhost` development host.
2. Register `http://localhost:3000/api/auth/callback/github` as the local GitHub callback.
3. Start the Rust Tengri service locally or point at an isolated development endpoint.

For a zero-downtime HMAC rotation, temporarily set `TENGRI_INTERNAL_HMAC_SECRET` to `new,current`. The BFF emits both
signatures until the controller has refreshed the same bundle; remove the previous key only after both sides have
observed it.

Changing `TENGRI_PUBLIC_URL` rolls the landing Deployment through GitOps. One surge Pod keeps a ready web endpoint
available while the replacement starts; existing streams reconnect when the old Pod terminates.
Merge the reviewed configuration, let Argo follow the Kargo deployment branch and replace the Pod, then verify
`kubectl --context galactic-lan -n proompteng rollout status deployment/proompteng --timeout=5m` and confirm an
authenticated `/api/tengri` snapshot reports the expected `previewGatewayOrigin`. Existing MicroVM Pods and PVCs are
not touched. Roll back an image by re-promoting the last known-good Proompteng Freight through Kargo; do not apply or undo
the Deployment directly.

Code keeps recoverable drafts scoped to the GitHub owner and agent creation identity. File reads include a SHA-256
revision; saves require that base revision and verify the returned revision. A competing API save returns a conflict
and preserves the local draft. Guests from before conditional-save support remain readable, but editing requires a
sleep/resume update. Refresh the browser after both web and runtime promotion; older clients cannot submit
unconditional writes to the updated runtime.

Draft storage never evicts another unsaved edit to make room. When browser storage is unavailable or full, Tengri
keeps a temporary recovery copy and exposes a download on the desktop and lifecycle screens. A page-unload warning
remains active until those edits are saved or discarded. Temporary copies cannot survive a browser restart, so
download them before closing the tab if storage cannot be restored.

## Validation

### Desktop design and interaction

The Tengri desktop uses macOS-style unified toolbars, full-height sidebars, restrained window shadows, and a
proximity-magnifying Dock. Apple’s original Big Sur wallpaper and application artwork are bundled locally; provenance
is in [`public/tengri/README.md`](public/tengri/README.md). Finder, Chrome, Code, Terminal, and Settings continue to
operate on the real guest workspace.

Desktop, setup, and confirmation windows share their traffic-light controls: 14 px flat circles with 23 px between centers,
with colors and rounded hover glyphs matched to native macOS screenshots. Each retains a separate 24 px hit target.
Available actions show symbols on hover or keyboard focus; unavailable actions are gray and disabled.
Closing a confirmation cancels it, and its controls stay
disabled while the confirmed operation runs.

Window movement and Dock magnification update transforms without React state changes per pointer frame. Pointer
geometry is measured at gesture boundaries; app content is memoized independently from window placement. The clock
updates its own leaf component. Minimized windows retain their application sessions and finish their animation at the
corresponding Dock icon. Reduced-motion preferences update while the desktop is open.

Dock magnification reserves space between icons and expands the glass background with transforms, using cached
geometry and limiting expansion at narrow viewport edges. Activating a window returns keyboard focus to its last
control; Terminal is ready for typing when opened. Minimize preserves the window's zoom state and normal bounds.
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

Finder's **Open in Code** sends a file-opening request through the owner-scoped gateway to a small guest extension using
VS Code's public API. The extension reports dirty tabs and uses native save/discard/cancel dialogs when closing a window.
Lifecycle changes are blocked while a window has unsaved edits or its save state is unknown. Settings and installed
extensions live in the persistent guest home; stable window origins preserve VS Code's workspace identity and native backups across reload.
Recoverable drafts from the previous editor remain available as downloads and never overwrite workspace files.
Sign-out first revokes the user's editor sessions, including those opened in other desktop tabs. If revocation fails,
the desktop keeps the user signed in and shows the error so they can retry.

Run the real integration test from the repository root:

```sh
bunx playwright install chromium
bash services/nanoagent/test-vscode-browser.sh
```

The runner requires Bun, Go, Rust, Node.js, OpenSSL, Python, and `protoc`. It downloads and verifies the pinned upstream release, starts
real Nanoagent and Tengri gateway fixtures, and drives the actual workbench through Chromium. Provisioning and identity
are local fixtures; editor files, terminals, WebSockets, cookie exchange, and CSP use their production implementations.
Ports 8080, 13338, 3143, 33082, 33083, and 3443 must be free. Logs are retained under `/tmp/tengri-vscode.*`.
The local TLS proxy and isolated test certificate exercise secure cookies, WebSockets, and the production CSP without
weakening application policy. To test an existing production build, set `TENGRI_EDITOR_NEXT_MODE=start`.
The verified release is cached under `node_modules/.cache/tengri-code-server`; `TENGRI_EDITOR_INSTALL_HOME` can select
an existing installation cache without reusing a test workspace.
