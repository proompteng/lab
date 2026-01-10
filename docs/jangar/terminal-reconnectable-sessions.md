# Jangar terminal sessions (reconnectable)

## Overview

Jangar terminals now run on a dedicated `jangar-terminal` deployment that owns PTY processes and keeps sessions alive across Jangar UI restarts. The UI connects directly to the terminal backend over WebSocket using a reconnect token and binary frames.

## Deployment

1) Build + push the Jangar image:

```bash
bun run packages/scripts/src/jangar/deploy-service.ts
```

2) Apply GitOps updates (Argo CD will reconcile):

```bash
argocd app sync jangar
```

## Configuration

- `JANGAR_TERMINAL_BACKEND_URL` (Jangar UI): internal URL for the terminal backend, e.g.
  `http://jangar-terminal.jangar.svc.cluster.local`.
- `JANGAR_TERMINAL_PUBLIC_URL` (jangar-terminal): public base URL used by the UI to open WebSockets,
  e.g. `https://jangar-terminal` (Tailscale service).
- `JANGAR_TERMINAL_BACKEND_ID` (jangar-terminal): unique backend identifier (defaults to pod name).
- `JANGAR_TERMINAL_IDLE_TIMEOUT_MS`: idle timeout before terminating a detached session.
- `JANGAR_TERMINAL_BUFFER_BYTES`: output buffer size for reconnect replay.

## Notes

- Terminals use binary WebSocket streaming with a small frame header. Control messages (resize/ping/etc.)
  use JSON text frames.
- `/api/terminals` remains the canonical API for session lifecycle and is proxied to the terminal backend
  when `JANGAR_TERMINAL_BACKEND_URL` is configured.
- `/terminals/$sessionId/fullscreen` provides a full-viewport terminal view intended for new tab usage.
