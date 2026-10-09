# Tengri agent chat

Tengri's Chrome home page (`tengri://agent`) is the Codex client for the signed-in user's microVM. It is not a log
viewer and it does not use AgentRun. The browser talks only to the authenticated Next.js BFF; the BFF signs the GitHub
subject for the Rust Tengri control plane; Tengri reaches Nanoagent through the owner's authenticated Firecracker slot supervisor.

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
2. The BFF reads the guest's Codex account state. If the user is not authenticated, it also reads any active
   ChatGPT device-code login from Nanoagent. A browser reconnect keeps the same code and original expiry; only an
   explicit restart invalidates that attempt.
3. Nanoagent persists the resulting Codex login under the PVC-backed user home. Tengri does not inject or share an
   `OPENAI_API_KEY`.
4. The first message creates a thread. The browser keeps the **active** thread id in `tengri-thread:${agentId}` and a
   client-side conversation registry in `tengri-conversations:${agentId}` (`{ id, title, updatedAt }[]`, title from the
   first user message). Later messages resume the active thread. The left sidebar lists registry entries (newest first);
   choosing one sets the active thread and resumes it. **New conversation** clears the active thread and transcript UI
   without removing other registry entries or guest-side thread state. There is no `ListCodexThreads` gRPC yet.
5. A message starts a turn. While that turn is active, subsequent input steers it and the stop control interrupts it.
6. Typed app-server events update assistant text, reasoning summaries, plans, tools, file changes, approvals, usage,
   warnings, and errors in place.

The chat, Finder, Code, Terminal, and preview tabs all operate on the same guest home and `/workspace` filesystem.

## Model and reasoning selection

The chat defaults to `gpt-6.1-sol`. Its **Model** selector reads the signed-in guest's paginated `model/list` catalog;
the **Reasoning effort** selector offers that model's supported efforts and displays its default effort. Both settings
are saved per agent in the browser and sent explicitly on thread creation, thread resume, and every subsequent turn.
Changing models resets an incompatible effort to the selected model's default. New conversations keep the settings.
An active turn keeps its original settings; the selectors become available after it finishes.

If the catalog fails to load, the chat displays the error with **Retry models** and blocks starting a new turn.
During a rollout, an older controller or guest can explicitly report that model selection is unsupported. The chat
then explains that it uses the existing Codex settings and continues sending without model or reasoning overrides.
Updated guests default to `gpt-6.1-sol`; omitted options preserve the guest configuration and existing thread settings.
Retrying the catalog restores the selectors when the compatible controller and guest are available.
If the account does not offer the selected model or effort, the selection stays visible until the user chooses an
available option. An unavailable saved selection is not applied during automatic recovery, and the selectors stay
editable after recovery fails so the user can choose valid settings and retry the same conversation. Tengri does not
silently substitute a model. A running turn can still be steered or interrupted.

## Guest administration

Terminal and Codex operate in a guest with a writable operating-system root and passwordless `sudo` for the
`nanoagent` user. The owner can install system packages, edit `/etc` and `/usr/local`, manage guest processes, mount
filesystems, and configure guest networking. Codex uses `danger-full-access`; the Firecracker VM provides the isolation
boundary around guest administration.

The root filesystem has 1 GiB capacity. Snapshot sleep/resume preserves root changes and guest processes while releasing
resident guest RAM. A fenced cold replacement resets the root from the image. Home and `/workspace` use the retained
32 GiB PVC, including Codex credentials, threads, and installed tools. Ordinary sleep keeps the claimed runtime image.

## API path

The public browser surface uses strict action schemas rather than exposing arbitrary app-server calls:

| Browser action       | Internal gRPC          | Guest app-server operation          |
| -------------------- | ---------------------- | ----------------------------------- |
| `codex-account`      | `GetCodexAccount`      | `account/read`                      |
| `codex-login-status` | `GetCodexLogin`        | Nanoagent active-login snapshot     |
| `codex-login`        | `StartCodexLogin`      | `account/login/start`               |
| `codex-models`       | `ListCodexModels`      | `model/list`                        |
| `create-thread`      | `CreateCodexThread`    | `thread/start`                      |
| `resume-thread`      | `ResumeCodexThread`    | `thread/resume`                     |
| `send-turn`          | `SendCodexInput`       | `turn/start`                        |
| `steer-turn`         | `SteerCodexInput`      | `turn/steer`                        |
| `interrupt-turn`     | `InterruptCodexTurn`   | `turn/interrupt`                    |
| `resolve-approval`   | `ResolveCodexApproval` | pending server-request response     |
| event stream         | `WatchCodexEvents`     | replayable app-server notifications |

Caller-supplied IDs and prompts are bounded and validated at the BFF and control-plane boundaries. The controller waits
for truthful guest readiness before forwarding an operation, so a sleeping agent resumes before the request continues.

## Event and recovery contract

- Event sequence numbers are monotonic per Nanoagent process. The browser reconnects with its last accepted sequence.
- Nanoagent retains a bounded replay window. Each thread snapshot carries the event sequence captured atomically when
  the app-server response is received. The browser drops snapshot-covered events and merges only events after that
  cursor into an in-progress restored item, so independent HTTP and SSE delivery cannot duplicate or truncate output.
- If the requested sequence is older than the replay window, Nanoagent emits `tengri/replayWarning`. The browser then
  resumes the authoritative thread, restores its transcript, and recovers any still-active turn before accepting more
  input.
- Completed item notifications replace their streamed deltas. Full plan and aggregate diff notifications replace the
  prior snapshot for the same thread and turn.
- A resolved approval removes the matching pending approval card. The UI presents only the decisions advertised by the
  request, including command-policy and network-policy amendments when supplied.
- Codex's empty-form MCP tool confirmations use the same approval card, showing the requested tool and arguments.
  Oversized confirmations retain bounded display and scope metadata and explicitly report omitted arguments.
  Approve once allows that call; advertised session approval remembers the tool in the current session. Deny declines
  the call, and Stop interrupts the turn and invalidates its pending controls. Read-only tools retain Codex's normal
  approval behavior. Input forms and URL/access elicitation are not interpreted as tool approvals: the desktop reports
  the unsupported request and cancels it without attributing a decision to the user.
- A failed turn renders the app-server failure text as an error before clearing active-turn controls.
- A missing saved conversation returns HTTP 404 with `code: conversation_not_found`, rather than a control-plane
  outage. The desktop keeps the saved thread ID during retries and offers **Start a new conversation** beside the
  error. Only that explicit action clears the browser's active selection; the next message creates a thread in the same
  guest workspace. The matching registry entry can be marked unavailable without wiping other conversations. Temporary
  failures remain retryable without replacing the conversation or resetting the agent.
- Deleting an agent clears `tengri-thread:${agentId}` and `tengri-conversations:${agentId}` alongside other desktop
  local/session keys for that agent.
- Account refreshes and login-completion events are tied to the current device-login attempt so stale responses cannot
  overwrite a newer login.
- A reconnecting browser restores the active device-login snapshot from the same app-server generation. Nanoagent
  rejects a stale snapshot after the app server restarts, and Tengri preserves the attempt's original expiry.
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
  apps/landing/src/lib/tengri/codex-models.test.ts \
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
2. Verify its slot Pod uses the normal OCI runtime, `privileged: false`, and no host namespaces or filesystem mounts.
   In Terminal, verify `sudo -n id -u` returns `0` and an owner-requested system-file edit or package install succeeds.
3. Open Chrome at `tengri://agent`, complete a per-user Codex device login, and create a thread.
4. Select a model and supported reasoning effort. Send a real turn that reads or edits `/workspace`; confirm the
   app-server model/effort readback and typed assistant, tool, and file-diff events. Reload and verify the selection.
5. Exercise one advertised approval decision, steer or interrupt a running turn, and reload Chrome during a turn to
   prove replay and thread recovery.
6. Read the changed file in Finder, Code, and Terminal to prove all surfaces share the same guest filesystem.
7. Sleep and resume the agent; verify the VMM exited during sleep, then verify the same shell PID, Codex account,
   thread, root edits, and home files. Measure authenticated creation/resume through file, terminal, and Codex readiness.

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
