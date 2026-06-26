# ChatGPT Dev-Shell MCP Tunnel

This runbook connects ChatGPT to a private shell MCP server in the Kubernetes `agents` namespace through an OpenAI
Secure MCP Tunnel. It intentionally does not expose public ingress and does not grant Kubernetes `pods/exec`.

## Tunnel

- Tunnel name: `agents`
- Tunnel ID: `tunnel_6a3e0c93576481919403b1ae9edeafd0`
- Binary: `openai/tunnel-client` release `v0.0.9--context-conduit-topaz`
- Linux assets: `linux-amd64.zip` or `linux-arm64.zip`
- Build verification: `SHA256SUMS.txt` is checked in `services/agents/Dockerfile`

The tunnel sidecar runs:

```bash
tunnel-client run \
  --control-plane.tunnel-id tunnel_6a3e0c93576481919403b1ae9edeafd0 \
  --control-plane.api-key file:/var/run/secrets/openai-tunnel/api-key \
  --mcp.server-url url=http://127.0.0.1:8090/mcp,channel=main \
  --health.listen-addr 0.0.0.0:8081 \
  --log.format json
```

## Kubernetes

Enable `devShell` in `argocd/applications/agents/values.yaml` only with an immutable image digest:

```yaml
devShell:
  enabled: true
  image:
    repository: registry.ide-newton.ts.net/lab/agents-dev-shell
    tag: <git-sha>
    digest: sha256:<digest>
  externalSecret:
    enabled: true
    remoteRef:
      key: openai-tunnel-client/agents-control-plane-api-key
```

Store the OpenAI tunnel `CONTROL_PLANE_API_KEY` in 1Password at the configured ExternalSecret key, or create a Secret
named `openai-tunnel-client` with key `api-key`. Do not place the key in Helm values.

## ChatGPT

1. In Platform tunnel settings, associate the `agents` tunnel with the target ChatGPT workspace.
2. In ChatGPT, create a connector with connection type `Tunnel` and select `agents`.
3. Name: `Agents Dev Shell`.
4. Description: `Executes commands inside a private Kubernetes dev-shell container through an OpenAI Secure MCP Tunnel.`
5. For private single-user use, no OAuth is acceptable if ChatGPT allows it. For shared use, add OAuth before enabling
   arbitrary shell tools.

## Validation

```bash
kubectl -n agents get pod -l app.kubernetes.io/component=dev-shell
kubectl -n agents port-forward deploy/agents-dev-shell 8090:8090 8081:8081
curl -fsS http://127.0.0.1:8081/readyz
curl -fsS http://127.0.0.1:8090/readyz
```

MCP smoke request:

```bash
curl -fsS http://127.0.0.1:8090/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shell_run","arguments":{"command":"pwd && python3 --version"}}}'
```

Tunnel diagnostic from inside the pod:

```bash
tunnel-client doctor \
  --control-plane.tunnel-id tunnel_6a3e0c93576481919403b1ae9edeafd0 \
  --control-plane.api-key file:/var/run/secrets/openai-tunnel/api-key \
  --mcp.server-url url=http://127.0.0.1:8090/mcp,channel=main \
  --explain
```
