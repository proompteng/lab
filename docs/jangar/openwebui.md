# OpenWebUI sidecar (JNG-070b/080b)

OpenWebUI now runs as a sidecar in the `ksvc/jangar` pod and talks to the worker’s OpenAI-compatible proxy at `http://localhost:8080/openai/v1`. We no longer inject an `OPENAI_API_KEY`; traffic stays inside the pod and uses the local Codex binary.

## Access and model surface
- Port-forward for local smoke tests:
  ```bash
  kubectl -n jangar port-forward ksvc/jangar 8080:80
  # then open http://localhost:3000
  ```
- OpenWebUI authentication and signup are disabled (`WEBUI_AUTH=false`, `ENABLE_SIGNUP=false`); requests go to the local proxy without an API key.
- Only the `meta-orchestrator` model is advertised (default model env is set; the proxy’s `/v1/models` response should continue to return just that entry).
- Local docker/`npm run dev:all` now read `JANGAR_OPENAI_BASE_URL` (defaults to
  `http://host.docker.internal:3000/openai/v1`) so the iframe always points at the Jangar
  OpenAI-compatible endpoint; bump this if you run the shell on a non-standard port.

## Image pin
- Sidecar image: `ghcr.io/open-webui/open-webui:v0.6.40`

## Embedding and local dev
- Jangar UI embeds OpenWebUI via an iframe in the mission view. Configure the src with `VITE_OPENWEBUI_URL` (defaults to `http://localhost:3000`).
- For local hacking, run everything together: `cd services/jangar && bun run dev:all` (starts OpenWebUI in Docker on :3000, Convex dev, the app shell, and the worker). If port 3000 is busy, set `OPENWEBUI_PORT=3001` (and `VITE_OPENWEBUI_URL=http://localhost:3001`).
- Update here if the tag/digest is bumped so ops can reason about the running build.
