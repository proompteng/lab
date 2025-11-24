# OpenWebUI sidecar (JNG-070b/080b)

OpenWebUI now runs as a sidecar in the `ksvc/jangar` pod and talks to the worker’s OpenAI-compatible proxy at `http://localhost:8080/openai/v1` using a shared bearer secret.

## Secrets
- **Secret name:** `jangar-openwebui-secret`
- **Key:** `OPENAI_API_KEY`
- **Mount path:** `/var/run/secrets/jangar-openwebui` in both `worker` and `openwebui` containers

### Create / rotate
```bash
kubectl -n jangar create secret generic jangar-openwebui-secret \
  --from-literal=OPENAI_API_KEY='<new-shared-bearer>' \
  --dry-run=client -o yaml | kubectl apply -f -
```
- Apply the secret before (or immediately after) ArgoCD sync so both containers pick up the new bearer.
- The manifest in `argocd/applications/jangar/openwebui-secret.yaml` contains a placeholder value; always override it per environment.

## Access and model surface
- Port-forward for local smoke tests:
  ```bash
  kubectl -n jangar port-forward ksvc/jangar 8080:80
  # then open http://localhost:3000
  ```
- OpenWebUI authentication and signup are disabled (`WEBUI_AUTH=false`, `ENABLE_SIGNUP=false`); all traffic relies on the shared bearer injected as `OPENAI_API_KEY`.
- Only the `meta-orchestrator` model is advertised (default model env is set; the proxy’s `/v1/models` response should continue to return just that entry).

## Image pin
- Sidecar image: `ghcr.io/open-webui/open-webui:v0.6.36@sha256:dfe43b30a5474164b1a81e1cce298a6769bb22144f74df556beefee4ccca5394`
- Update here if the tag/digest is bumped so ops can reason about the running build.
