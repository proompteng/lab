# OpenWebUI deployment (separate host)

OpenWebUI is installed via the upstream Helm chart (`open-webui` v8.19.0, app v0.7.2) in the `jangar` namespace. The chart creates a StatefulSet and `open-webui` ClusterIP Service; a dedicated Tailscale LoadBalancer `openwebui-tailscale` (hostname `openwebui`) fronts it. Websocket support is enabled and backed by a Redis instance `jangar-openwebui-redis` managed by the OTCK Redis operator. Postgres comes from the existing CNPG cluster `jangar-db` (`jangar-db-app` + `jangar-db-ca`). Jangar no longer proxies or iframes OpenWebUI; users open the Tailscale host directly.

OpenWebUI forwards the chat identifier in the `x-openwebui-chat-id` header (enabled via the chart values). Jangar consumes this header to map conversations to Codex thread ids and to increment turn numbers, persisting the mapping in Redis (`redis://jangar-openwebui-redis:6379/1`) with a 7-day TTL so subsequent turns stay on the same thread.

## Access
- Via Tailscale: `http://openwebui` (Tailscale LB `openwebui-tailscale` → Service `open-webui:80` → pod :8080).
- Local smoke test (no tailscale):
  ```bash
  # Service forward (preferred):
  kubectl -n jangar port-forward svc/open-webui 8080:80
  # or directly to the StatefulSet pod:
  kubectl -n jangar port-forward statefulset/open-webui 8080:8080
  # browser: http://localhost:8080/
  ```

## Model & backend wiring
- OpenAI base URL: `http://jangar.jangar.svc.cluster.local/openai/v1` (set via Helm values).
- Auth/signup remain disabled (`WEBUI_AUTH=false`, `ENABLE_SIGNUP=false`).
- Websockets: `WEBSOCKET_MANAGER=redis`, `WEBSOCKET_REDIS_URL=redis://jangar-openwebui-redis:6379/0` (Redis provided by the operator, not the chart).
- Database: `DATABASE_URL` from CNPG secret `jangar-db-app`; TLS root cert from `jangar-db-ca`.
- Current code returns configured models from `/v1/models` (default `gpt-5.3-codex,gpt-5.3-codex-spark`); set `JANGAR_MODELS`/`JANGAR_DEFAULT_MODEL` or update `services/jangar/src/server/config.ts` if this needs to change.

## Image pin
- `ghcr.io/open-webui/open-webui:v0.7.2` (managed by the Helm chart)

## Dev notes
- Jangar UI no longer embeds OpenWebUI; if you want a quick link, point to `VITE_OPENWEBUI_EXTERNAL_URL` when running locally.
- For local all-in-one: `cd services/jangar && bun run dev:all` still starts OpenWebUI (Docker) on :3000; override `OPENWEBUI_PORT` if needed.
