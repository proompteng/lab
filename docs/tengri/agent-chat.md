# Tengri agent chat

Tengri's Chrome home page (`tengri://agent`) is the Codex client for the signed-in user's microVM. It is not a log
viewer and it does not use AgentRun. The browser talks only to the authenticated Next.js BFF; the BFF signs the GitHub
subject for the Rust Tengri control plane; Tengri calls the Nanoagent process inside the owner's `kata-fc` guest.

```text
Chrome agent tab
  -> authenticated Next.js BFF
  -> signed internal gRPC
  -> Tengri owner check and guest readiness
  -> Nanoagent Codex app-server supervisor
  -> one Codex account and persisted threads in the owner's PVC
```

The browser never receives Kubernetes credentials, the internal HMAC key, the guest bootstrap token, or another
owner's agent identifiers. Every account, thread, turn, approval, and event-stream operation is authorized from the
signed GitHub subject and the server-owned `MicroVM` owner hash.

## User flow

1. Chrome opens its first tab at `tengri://agent` and renders the agent chat for the active microVM.
2. The BFF reads the guest's Codex account state. If the user is not authenticated, the UI starts a ChatGPT device-code
   login. The code and verification URL are short-lived and can be restarted without remounting the desktop.
3. Nanoagent persists the resulting Codex login under the PVC-backed user home. Tengri does not inject or share an
   `OPENAI_API_KEY`.
4. The first message creates a thread. Later messages resume the browser's persisted thread ID, and **New
   conversation** starts a separate thread without deleting earlier guest-side thread state.
5. A message starts a turn. While that turn is active, subsequent input steers it and the stop control interrupts it.
6. Typed app-server events update assistant text, reasoning summaries, plans, tools, file changes, approvals, usage,
   warnings, and errors in place.

The chat, Finder, Code, Terminal, and preview tabs all operate on the same guest home and `/workspace` filesystem.

## API path

The public browser surface uses strict action schemas rather than exposing arbitrary app-server calls:

| Browser action     | Internal gRPC          | Guest app-server operation          |
| ------------------ | ---------------------- | ----------------------------------- |
| `codex-account`    | `GetCodexAccount`      | `account/read`                      |
| `codex-login`      | `StartCodexLogin`      | `account/login/start`               |
| `create-thread`    | `CreateCodexThread`    | `thread/start`                      |
| `resume-thread`    | `ResumeCodexThread`    | `thread/resume`                     |
| `send-turn`        | `SendCodexTurn`        | `turn/start`                        |
| `steer-turn`       | `SteerCodexTurn`       | `turn/steer`                        |
| `interrupt-turn`   | `InterruptCodexTurn`   | `turn/interrupt`                    |
| `resolve-approval` | `ResolveCodexApproval` | pending server-request response     |
| event stream       | `WatchCodexEvents`     | replayable app-server notifications |

Caller-supplied IDs and prompts are bounded and validated at the BFF and control-plane boundaries. The controller waits
for truthful guest readiness before forwarding an operation, so a sleeping agent resumes before the request continues.

## Event and recovery contract

- Event sequence numbers are monotonic per Nanoagent process. The browser reconnects with its last accepted sequence.
- Nanoagent retains a bounded replay window. Duplicate replayed events are ignored, while live deltas may replace an
  in-progress item restored from `thread/resume`.
- If the requested sequence is older than the replay window, Nanoagent emits `tengri/replayWarning`. The browser then
  resumes the authoritative thread, restores its transcript, and recovers any still-active turn before accepting more
  input.
- Completed item notifications replace their streamed deltas. Full plan and aggregate diff notifications replace the
  prior snapshot for the same thread and turn.
- A resolved approval removes the matching pending approval card. The UI presents only the decisions advertised by the
  request, including command-policy and network-policy amendments when supplied.
- A failed turn renders the app-server failure text as an error before clearing active-turn controls.
- Account refreshes and login-completion events are tied to the current device-login attempt so stale responses cannot
  overwrite a newer login.
- The UI caps retained events and rendered text. It does not render remote Markdown images or raw unbounded app-server
  payloads.

Closing and reopening Chrome does not terminate Codex. Nanoagent supervises one long-lived `codex app-server` process;
browser reconnects restore the persisted thread and event state from the same microVM.

## Validation

Focused local validation for the browser, BFF, and event contract:

```bash
set -euo pipefail

bun test \
  apps/landing/src/components/tengri/codex-events.test.ts \
  apps/landing/src/components/tengri/codex-event-card.test.tsx \
  apps/landing/src/lib/tengri/grpc.test.ts \
  apps/landing/src/lib/tengri/schemas.test.ts \
  apps/landing/src/lib/tengri/sse.test.ts \
  apps/landing/src/lib/tengri/ready-desktop.test.tsx
bunx oxlint --type-aware \
  apps/landing/src/components/tengri/agent-chat.tsx \
  apps/landing/src/components/tengri/codex-event-card.tsx \
  apps/landing/src/components/tengri/codex-events.ts \
  apps/landing/src/components/tengri/chrome-app.tsx
bun run build:landing
```

The live acceptance path runs only after the GitOps rollout described in
[`operations.md`](./operations.md). It must prove the complete owner-scoped path:

1. Sign in with GitHub and create or resume one agent.
2. Verify its Pod is unprivileged and uses `runtimeClassName: kata-fc` without changing node scheduling.
3. Open Chrome at `tengri://agent`, complete a per-user Codex device login, and create a thread.
4. Send a real turn that reads or edits `/workspace`; confirm typed assistant, tool, and file-diff events render.
5. Exercise one advertised approval decision, steer or interrupt a running turn, and reload Chrome during a turn to
   prove replay and thread recovery.
6. Read the changed file in Finder, Code, and Terminal to prove all surfaces share the same guest filesystem.
7. Sleep and resume the agent; verify the same Codex account and thread remain available from the retained PVC.

Do not substitute fixture output, a manually created Pod, a privileged launcher, or a permanent canary DaemonSet for
this acceptance path.

## Failure recovery

- **Device code expired or invalid:** restart device login in the existing Chrome tab. Do not recreate the microVM.
- **Event stream reconnecting:** leave the tab open while the BFF or Tengri endpoint returns; the client resumes from
  its last sequence and falls back to authoritative thread recovery if the replay window expired.
- **Thread cannot resume:** keep the exact error visible. Start a new conversation only when the user chooses to; do
  not silently replace the persisted thread.
- **Approval no longer exists:** refresh the event stream or thread state. Never broaden the decision beyond the
  request's advertised choices.
- **Guest unavailable:** inspect the `MicroVM` status condition and Nanoagent readiness. Repair the source-owned guest
  or controller problem through CI and GitOps; do not cordon, drain, reboot, or mutate Talos.
