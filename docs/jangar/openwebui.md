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

## Image pin
- Sidecar image: `ghcr.io/open-webui/open-webui:v0.6.36@sha256:dfe43b30a5474164b1a81e1cce298a6769bb22144f74df556beefee4ccca5394`
- Update here if the tag/digest is bumped so ops can reason about the running build.
