# OpenWebUI deployment (separate host)

OpenWebUI is installed via the upstream Helm chart in the `jangar` namespace. [The application Kustomization](../../argocd/applications/jangar/kustomization.yaml) owns the selected chart version and immutable image digest; [the chart values](../../argocd/applications/jangar/openwebui-values.yaml) own its runtime configuration. The chart creates a StatefulSet and `open-webui` ClusterIP Service; a dedicated Tailscale LoadBalancer `openwebui-tailscale` (hostname `openwebui`) fronts it. Websocket support is enabled and backed by a Redis instance `jangar-openwebui-redis` managed by the OTCK Redis operator. Postgres comes from the existing CNPG cluster `jangar-db` (`jangar-db-app` + `jangar-db-ca`). Jangar no longer proxies or iframes OpenWebUI; users open the Tailscale host directly.

OpenWebUI forwards the chat identifier in the `x-openwebui-chat-id` header (enabled via the chart values). Jangar consumes this header to map conversations to Codex thread ids and to increment turn numbers, persisting the mapping in Redis (`redis://jangar-openwebui-redis:6379/1`) with a 7-day TTL so subsequent turns stay on the same thread. The same 7-day retention window is used for staged OpenWebUI rich-detail blobs and their signed render links.

Implementation details and local regression coverage live in `docs/jangar/openwebui-rich-activity-implementation.md`.

## Rich activity details

The production OpenWebUI rich-activity path lives entirely inside Jangar. OpenWebUI still consumes standard `delta.content` and `delta.reasoning_content`; there is no OpenWebUI frontend fork and no OpenAI `tool_calls` requirement for this UX. When enabled, Jangar appends signed markdown links such as `Open full transcript`, `Open full diff`, `Open full result`, and `Open detail` directly into the assistant text stream.

Enable the production detail-link path with:

- `JANGAR_OPENWEBUI_RICH_RENDER_ENABLED=true`
- `JANGAR_OPENWEBUI_EXTERNAL_BASE_URL=<browser-reachable Jangar origin>`
- `JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET=<shared secret>`

`JANGAR_OPENWEBUI_EXTERNAL_BASE_URL` must be reachable from the end user's browser, not just from inside the cluster, because OpenWebUI renders links to Jangar's `/api/openwebui/rich-ui/render/$renderId` route. Signed links and staged render blobs share the same 7-day lifetime, so they expire on the same horizon as the persisted OpenWebUI chat/thread mapping.

If the external base URL, signing secret, or render store is unavailable, Jangar falls back to plain text streaming for that turn instead of failing the request.

The request header `x-jangar-openwebui-render-mode: rich-ui-v1` is optional and experimental. It only enables `delta.jangar_event` emission for debugging or future client work; the production text-plus-links path does not require it.

## Access

- Via Tailscale: `http://openwebui` (Tailscale LB `openwebui-tailscale` → Service `open-webui:80` → pod :8080).
- Local smoke test (no tailscale):
  ```bash
  # Service forward (preferred):
  kubectl --context galactic-lan -n jangar port-forward svc/open-webui 8080:80
  # or directly to the StatefulSet pod:
  kubectl --context galactic-lan -n jangar port-forward statefulset/open-webui 8080:8080
  # browser: http://localhost:8080/
  ```

## Model & backend wiring

- OpenAI backends: Flamingo first at `http://flamingo.flamingo.svc.cluster.local/v1`, then Jangar at `http://jangar.jangar.svc.cluster.local/openai/v1`. Chart values select the default model and preserve this order.
- Auth/signup remain disabled (`WEBUI_AUTH=false`, `ENABLE_SIGNUP=false`).
- Websockets: `WEBSOCKET_MANAGER=redis`, `WEBSOCKET_REDIS_URL=redis://jangar-openwebui-redis:6379/0` (Redis provided by the operator, not the chart).
- Database: `DATABASE_URL` from CNPG secret `jangar-db-app`; TLS root cert from `jangar-db-ca`.
- Current code returns configured models from `/v1/models` (default `gpt-6-astra`); set `JANGAR_MODELS`/`JANGAR_DEFAULT_MODEL` or update `services/jangar/src/server/config.ts` if this needs to change.

## Delivery and recovery

The normal Jangar image build and automatic Kargo promotion deliver the source selected on `main` to `kargo/jangar`. Check that branch's rendered image digests, the workload rollout, and a private browser chat completion before accepting a release. Keep release-specific versions, backup checksums, migration receipts, and live acceptance results in the PR record.

Before an OpenWebUI upgrade, take a native PostgreSQL backup of its public schema and retain the existing CNPG continuous backup and WAL archive. Back up the vector database and uploaded files on the existing OpenWebUI PVC. Use SQLite's online backup API for `vector_db/chroma.sqlite3` and require stable index-file hashes during the copy; downloaded model caches are reproducible and remain on the original PVC. Restore the backups into isolated storage with the selected image and verify account identities, existing chats, schema migrations, vector collections, and document counts before activation.

Preserve the existing PVCs, credentials, authentication settings, backend destinations, and service addresses. If a migration or startup fails, stop further upgrades and inspect the first error. Check schema compatibility before reverting an image through GitOps. Restore into an isolated instance before considering production recovery; do not point an older database engine at files rewritten by a newer major version.

### Jangar Docker lifecycle

[The Jangar Deployment](../../argocd/applications/jangar/deployment.yaml) runs Docker as a native Kubernetes sidecar. Its startup probe gates the app, and ordered termination keeps Docker available while the app shuts down. Keep classic overlay2 enabled because the app consumes the shared graph directory. The Docker graph and socket use existing emptyDir volumes; the workspace uses its existing PVC.

Before a Docker upgrade, check for active containers and verify the deployed app's Docker client against the selected daemon with an isolated container invocation. Preserve resource limits, mounts, and the bootstrap/app container indices consumed by Kargo. After rollout, repeat the real client/container check against the deployed daemon.

References: [OpenWebUI migrations](https://github.com/open-webui/open-webui/tree/main/backend/open_webui/migrations/versions), [Kubernetes sidecars](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/).

## Dev notes

- Jangar UI no longer embeds OpenWebUI; if you want a quick link, point to `VITE_OPENWEBUI_EXTERNAL_URL` when running locally.
- For local all-in-one: `cd services/jangar && bun run dev:all` still starts OpenWebUI (Docker) on :3000; override `OPENWEBUI_PORT` if needed.
