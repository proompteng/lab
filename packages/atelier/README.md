# Atelier Utilities

This workspace houses operational scripts that should not leak dependencies into the root project. Right now it ships a single helper for bootstrapping Temporal namespaces via Bun.

## `create-default-namespace.ts`

Creates a Temporal namespace after temporarily port-forwarding to the cluster. The script will:

1. Look up a Temporal frontend pod, or fall back to `kubectl` if direct API access fails.
2. Start a localhost port-forward to the Temporal frontend gRPC port (defaults to `7233`).
3. Connect to Temporal, describe the namespace, and register it if missing.
4. Close the port-forward before exiting.

### Prerequisites

- Bun installed locally (tested with Bun 1.3.10).
- A working kubeconfig for the cluster where Temporal runs.
- `kubectl` on your PATH if the script needs to fall back from the client SDK.

### Usage

```bash
bun run packages/atelier/src/create-default-namespace.ts \
  --kube-namespace temporal \
  --namespace default \
  --retention-days 3
```

Key flags:

- `--kube-namespace` (default `temporal`) – Kubernetes namespace to search for pods.
- `--kube-label-selector` – Label selector for the Temporal frontend pods. Defaults to `app.kubernetes.io/component=frontend,app.kubernetes.io/instance=temporal`.
- `--kube-context` – Override the kubeconfig context.
- `--kube-resource` – Resource to forward when using `kubectl` fallback (`svc/temporal-frontend` by default).
- `--kubectl-bin` – Path to a non-standard `kubectl` binary.
- `--local-port` – Force a specific local port instead of an ephemeral one.
- `--namespace` – Temporal namespace to ensure (`default`).
- `--retention-days` – Workflow retention period (default `3`).
- `--allow-insecure` – Trust self-signed TLS when connecting to Temporal.
- TLS inputs (`--tls`, `--ca-cert`, `--cert`, `--key`, `--server-name`) map to the Temporal client `TLSConfig`.

Environment variables mirror most options:

- `TEMPORAL_NAMESPACE`, `TEMPORAL_RETENTION_DAYS` – Namespace metadata.
- `TEMPORAL_API_KEY` or `TEMPORAL_OPERATOR_API_KEY` – Bearer token for Temporal Cloud / secured clusters.
- `TEMPORAL_ALLOW_INSECURE` – Set to `1`/`true` to trust self-signed certs.
- `TEMPORAL_KUBE_NAMESPACE`, `TEMPORAL_KUBE_LABEL_SELECTOR`, `TEMPORAL_KUBE_RESOURCE`, `TEMPORAL_KUBE_CONTEXT` – Kubernetes settings.
- `KUBECTL_BIN` – Override `kubectl` binary.

### Exit Codes

- `0` – Namespace exists or was created successfully.
- Non-zero – Failure at some point; the script logs the reason before exiting.

### Examples

Bootstrap the default namespace while trusting a self-signed control-plane certificate:

```bash
TEMPORAL_ALLOW_INSECURE=1 bun run packages/atelier/src/create-default-namespace.ts \
  --kube-namespace temporal \
  --namespace default \
  --retention-days 3 \
  --allow-insecure
```

Ensure a staging namespace with a 10-day retention, using a dedicated kube context and service name:

```bash
bun run packages/atelier/src/create-default-namespace.ts \
  --kube-context staging \
  --kube-resource svc/temporal-frontend-staging \
  --namespace staging \
  --retention-days 10
```

The script is idempotent: re-running it simply reports that the namespace already exists.
