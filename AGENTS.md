# Repository Guidelines

## Project Structure & Module Organization

- `apps/<app>` contains Next.js/Turbo UIs; keep UI fixtures and tests alongside components.
- Shared TS utilities stay in `packages/backend`; CDK8s blueprints sit in `packages/cloutt`.
- Go services live in `services/<service>` with `main.go` and adjacent `*_test.go` files.
- Infra-as-code spans `tofu/harvester` (OpenTofu), bootstrap tooling under `kubernetes/`, GitOps application specs in `argocd/`, automation scripts in `packages/scripts` and `scripts/`, plus Ansible plays in `ansible/`.

## Build, Test & Development Commands

- Install dependencies with `bun install` (Node 24.11.1, Bun 1.3.5) and run `go mod tidy` inside each Go service.
- Start UIs with `bun run dev:proompteng`; swap the suffix for sibling apps.
- Build and smoke test via `bun run build:<app>` then `bun run start:<app>`.
- Format and lint using `bun run format` and `bun run lint:<app>`.
- Run backend workflows through `go test ./...` and `go build ./...`.
- Regenerate Codex app-server TypeScript bindings when the protocol changes with `codex app-server generate-ts --out packages/codex/src/app-server`.
- Infra flow: `bun run tf:plan` (review), `bun run tf:apply` (approved), and `bun run ansible` for playbooks. Use the deployment helper scripts when touching automation services:
  - `bun apps/froussard/src/codex/cli/build-codex-image.ts` to rebuild/push the Codex runner image.
    - Script defaults to the `tuslagch` GitHub CLI account; override with `GH_TOKEN_USER=<other>` if needed. Container git commits use `tuslagch@proompteng.ai`.
  - `bun packages/scripts/src/froussard/deploy-service.ts` to build/push the Froussard Docker image (via `apps/froussard/Dockerfile`), stamp the Knative manifest with the new digest + `FROUSSARD_VERSION/FROUSSARD_COMMIT`, and `kubectl apply` the update.
  - `bun packages/scripts/src/facteur/deploy-service.ts` to build, push, and redeploy Facteur (applies the kustomize overlay and `kn service apply`).
- Whenever you change any TypeScript/JavaScript files, run the relevant Biome check command (e.g. `bunx biome check <paths>`) and resolve every diagnostic before pushing or opening a PR; mention the run in your PR description if manual fixes were required.

## Memories service helpers

- Save new entries with `bun run --filter memories save-memory --task-name … --content … --summary … --tags …` and query cached facts with `bun run --filter memories retrieve-memory --query …`. Both helpers emit logs tied to the `memories` schema defined in `schemas/embeddings/memories.sql`.

### Tooling Notes

- **kubectl**: the default kubeconfig on these hosts already targets the shared cluster. Avoid overriding `KUBECONFIG` unless you intentionally need another context; doing so can surface TLS or auth errors that do not occur with the default config.
- **argocd CLI**: keep usage read-only by default—prefer `argocd app get <app>` or `argocd app list` to inspect state, and only run mutating operations (syncs, rollbacks, deletes) when the playbook explicitly calls for them.
- **gh CLI**: when passing markdown in flags, wrap the entire value in single quotes or use `--body-file` with a heredoc. Backticks inside double-quoted arguments trigger shell command substitution and will break commands like `gh pr create`.
- Never edit compiled or generated artifacts (e.g., `dist/`, bundles inside running containers); change source and rebuild instead.

## Coding Style & Naming Conventions

- Run Biome before commits; it enforces two-space indentation, single quotes, trailing commas, and 120-character lines.
- Name files in kebab-case (`dialog-panel.tsx`, `cron-worker.go`).
- Order imports standard → third-party → internal with blank lines between groups.
- Prefer explicit conditional statements over nested ternaries for readability.
- Compose React UI with Tailwind utilities via `cn()` and keep schema validation in `schemas/` using Zod.
- Wrap Go errors as `fmt.Errorf("operation failed: %w", err)`.

## Testing Guidelines

- Keep Go tests as `*_test.go` next to implementation; narrow runs with `go test ./services/prt -run TestHandleRoot`.
- Write TypeScript tests as `*.test.ts`; trigger scoped runs with `bun run --filter cloutt test` or the appropriate workspace filter.
- Target fast unit coverage first, then log manual QA steps in PR descriptions.

## Commit & Pull Request Guidelines

- Adopt Conventional Commits (e.g. `feat: add prix cache`); use bodies for extra context or breaking notes.
- Commits and PR titles MUST use the approved types (`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`).
- PRs should summarize the change, link issues, list verification (`go test`, `bun run lint:<app>`), and attach UI screenshots when visuals shift.
- Always seed new PRs with the default template. Copy `.github/PULL_REQUEST_TEMPLATE.md` to a scratch file (e.g. `/tmp/pr.md`), fill in every section (Summary, Related Issues, Testing, Screenshots/None, Breaking Changes/None, Checklist), then run `gh pr create --body-file /tmp/pr.md`.
- Merge with squash (merge commits are blocked): `gh pr merge <number> --squash --delete-branch`.
- Keep scope tight, track follow-ups with TODOs, and document rollout or operational impacts.
- NEVER edit lockfiles (e.g. `bun.lock`) by hand—regenerate them with the package manager instead.

## Cursor Agent CLI

- Executable path: confirm with `which cursor-agent`; typically `~/.local/bin/cursor-agent`.
- Invocation shape: `cursor-agent [options] [command] [prompt...]`.
- Common workflow for Codex automation: `cursor-agent --print "<instruction>"` (non-interactive output to stdout).
- Global options:
  - `-v, --version` — print the version and exit.
  - `--api-key <key>` — provide API key (otherwise read from `CURSOR_API_KEY`).
  - `-p, --print` — stream agent responses to stdout (required for CLI scripts).
  - `--output-format <text|json|stream-json>` — adjust payload (only with `--print`).
  - `--stream-partial-output` — emit incremental deltas (requires `--print` + `stream-json`).
  - `-b, --background` — start in background/composer mode.
  - `--resume [chatId]` — reconnect to an existing session (omit ID to resume latest).
  - `--model <name>` — pick model (e.g. `gpt-5`, `sonnet-4`).
  - `-f, --force` — auto-approve commands unless explicitly denied.
  - `-h, --help` — display help message.
- Subcommands:
  - `agent [prompt...]` — launch an interactive run with optional opening prompt.
  - `create-chat` — start an empty chat and return its ID.
  - `ls` — list resumable chat sessions.
  - `resume [chatId]` — resume latest (or specific) chat session.
  - `install-shell-integration` / `uninstall-shell-integration` — manage shell hooks.
  - `login` / `logout` — manage authentication state.
  - `mcp` — manage MCP servers.
  - `status` or `whoami` — show authentication details.
  - `sandbox` — inspect sandbox configuration.
  - `update` / `upgrade` — update Cursor Agent.
  - `help [command]` — show help for a subcommand.
- Example (streaming JSON with force + sonnet-4.5):
  ```bash
  cursor-agent --print --output-format stream-json --stream-partial-output --force --model sonnet-4.5-thinking "Describe current workspace status"
  ```
- Non-zero exit codes indicate command failures; inspect stderr for details.

## Codex Progress Comment Flow

- Maintain exactly one implementation progress comment per issue, anchored by `<!-- codex:progress -->`.
- Use `apps/froussard/src/codex/cli/codex-progress-comment.ts` to create or update that comment; provide the markdown via stdin or `--body-file`.
- Required env vars: `ISSUE_REPO` and `ISSUE_NUMBER`. Optional overrides: `CODEX_PROGRESS_COMMENT_MARKER` and `CODEX_PROGRESS_COMMENT_LOG_PATH` (falls back to `.codex-implementation.log`).
- Kickoff body should restate the approved plan as a checklist, flag the active step, and capture risks/tests so reviewers can track work in flight.
- Update the comment after each milestone—reuse the same comment rather than adding new ones—and include links to validation where helpful.
- At completion, mark the checklist done, replace the status block with the final summary/validation, and confirm the helper logs the resulting `comment_id`/`comment_url`.
- Use `--dry-run` when validating locally; it prints the resolved action/body without mutating GitHub.

## Security & Operations Notes

- ArgoCD reconciles desired state; edit manifests in `argocd/` and let automation deploy.
- Application directories under `argocd/applications/` must expose Kustomize or raw manifests only; the platform `ApplicationSet` owns the Argo CD `Application` objects (no nested `Application` manifests).
- Pair Terraform plans from `bun run tf:plan` with review before `bun run tf:apply`; note outcomes after applies.
- Prefer read-only `kubectl -n <namespace> get ...` for production checks and capture findings in runbooks.

## Interactions

- Keyboard
  - MUST: Full keyboard support per [WAI-ARIA APG](https://wwww3org/WAI/ARIA/apg/patterns/)
  - MUST: Visible focus rings (`:focus-visible`; group with `:focus-within`)
  - MUST: Manage focus (trap, move, and return) per APG patterns
- Targets & input
  - MUST: Hit target ≥24px (mobile ≥44px) If visual <24px, expand hit area
  - MUST: Mobile `<input>` font-size ≥16px or set:
    ```html
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
    ```
  - NEVER: Disable browser zoom
  - MUST: `touch-action: manipulation` to prevent double-tap zoom; set `-webkit-tap-highlight-color` to match design
- Inputs & forms (behavior)
  - MUST: Hydration-safe inputs (no lost focus/value)
  - NEVER: Block paste in `<input>/<textarea>`
  - MUST: Loading buttons show spinner and keep original label
  - MUST: Enter submits focused text input In `<textarea>`, ⌘/Ctrl+Enter submits; Enter adds newline
  - MUST: Keep submit enabled until request starts; then disable, show spinner, use idempotency key
  - MUST: Don’t block typing; accept free text and validate after
  - MUST: Allow submitting incomplete forms to surface validation
  - MUST: Errors inline next to fields; on submit, focus first error
  - MUST: `autocomplete` + meaningful `name`; correct `type` and `inputmode`
  - SHOULD: Disable spellcheck for emails/codes/usernames
  - SHOULD: Placeholders end with ellipsis and show example pattern (eg, `+1 (123) 456-7890`, `sk-012345…`)
  - MUST: Warn on unsaved changes before navigation
  - MUST: Compatible with password managers & 2FA; allow pasting one-time codes
  - MUST: Trim values to handle text expansion trailing spaces
  - MUST: No dead zones on checkboxes/radios; label+control share one generous hit target
- State & navigation
  - MUST: URL reflects state (deep-link filters/tabs/pagination/expanded panels) Prefer libs like [nuqs](https://nuqs47ngcom/)
  - MUST: Back/Forward restores scroll
  - MUST: Links are links—use `<a>/<Link>` for navigation (support Cmd/Ctrl/middle-click)
- Feedback
  - SHOULD: Optimistic UI; reconcile on response; on failure show error and rollback or offer Undo
  - MUST: Confirm destructive actions or provide Undo window
  - MUST: Use polite `aria-live` for toasts/inline validation
  - SHOULD: Ellipsis (`…`) for options that open follow-ups (eg, “Rename…”)
- Touch/drag/scroll
  - MUST: Design forgiving interactions (generous targets, clear affordances; avoid finickiness)
  - MUST: Delay first tooltip in a group; subsequent peers no delay
  - MUST: Intentional `overscroll-behavior: contain` in modals/drawers
  - MUST: During drag, disable text selection and set `inert` on dragged element/containers
  - MUST: No “dead-looking” interactive zones—if it looks clickable, it is
- Autofocus
  - SHOULD: Autofocus on desktop when there’s a single primary input; rarely on mobile (to avoid layout shift)

## Animation

- MUST: Honor `prefers-reduced-motion` (provide reduced variant)
- SHOULD: Prefer CSS > Web Animations API > JS libraries
- MUST: Animate compositor-friendly props (`transform`, `opacity`); avoid layout/repaint props (`top/left/width/height`)
- SHOULD: Animate only to clarify cause/effect or add deliberate delight
- SHOULD: Choose easing to match the change (size/distance/trigger)
- MUST: Animations are interruptible and input-driven (avoid autoplay)
- MUST: Correct `transform-origin` (motion starts where it “physically” should)

## Layout

- SHOULD: Optical alignment; adjust by ±1px when perception beats geometry
- MUST: Deliberate alignment to grid/baseline/edges/optical centers—no accidental placement
- SHOULD: Balance icon/text lockups (stroke/weight/size/spacing/color)
- MUST: Verify mobile, laptop, ultra-wide (simulate ultra-wide at 50% zoom)
- MUST: Respect safe areas (use env(safe-area-inset-\*))
- MUST: Avoid unwanted scrollbars; fix overflows

## Content & Accessibility

- SHOULD: Inline help first; tooltips last resort
- MUST: Skeletons mirror final content to avoid layout shift
- MUST: `<title>` matches current context
- MUST: No dead ends; always offer next step/recovery
- MUST: Design empty/sparse/dense/error states
- SHOULD: Curly quotes (“ ”); avoid widows/orphans
- MUST: Tabular numbers for comparisons (`font-variant-numeric: tabular-nums` or a mono like Geist Mono)
- MUST: Redundant status cues (not color-only); icons have text labels
- MUST: Don’t ship the schema—visuals may omit labels but accessible names still exist
- MUST: Use the ellipsis character `…` (not ``)
- MUST: `scroll-margin-top` on headings for anchored links; include a “Skip to content” link; hierarchical `<h1–h6>`
- MUST: Resilient to user-generated content (short/avg/very long)
- MUST: Locale-aware dates/times/numbers/currency
- MUST: Accurate names (`aria-label`), decorative elements `aria-hidden`, verify in the Accessibility Tree
- MUST: Icon-only buttons have descriptive `aria-label`
- MUST: Prefer native semantics (`button`, `a`, `label`, `table`) before ARIA
- SHOULD: Right-clicking the nav logo surfaces brand assets
- MUST: Use non-breaking spaces to glue terms: `10&nbsp;MB`, `⌘&nbsp;+&nbsp;K`, `Vercel&nbsp;SDK`

## Performance

- SHOULD: Test iOS Low Power Mode and macOS Safari
- MUST: Measure reliably (disable extensions that skew runtime)
- MUST: Track and minimize re-renders (React DevTools/React Scan)
- MUST: Profile with CPU/network throttling
- MUST: Batch layout reads/writes; avoid unnecessary reflows/repaints
- MUST: Mutations (`POST/PATCH/DELETE`) target <500 ms
- SHOULD: Prefer uncontrolled inputs; make controlled loops cheap (keystroke cost)
- MUST: Virtualize large lists (eg, `virtua`)
- MUST: Preload only above-the-fold images; lazy-load the rest
- MUST: Prevent CLS from images (explicit dimensions or reserved space)

## Design

- SHOULD: Layered shadows (ambient + direct)
- SHOULD: Crisp edges via semi-transparent borders + shadows
- SHOULD: Nested radii: child ≤ parent; concentric
- SHOULD: Hue consistency: tint borders/shadows/text toward bg hue
- MUST: Accessible charts (color-blind-friendly palettes)
- MUST: Meet contrast—prefer [APCA](https://apcacontrastcom/) over WCAG 2
- MUST: Increase contrast on `:hover/:active/:focus`
- SHOULD: Match browser UI to bg
- SHOULD: Avoid gradient banding (use masks when needed)
