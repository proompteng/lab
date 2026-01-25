# agentctl

`agentctl` is the CLI for managing Agents primitives through the Jangar controller. It defaults to Kubernetes
API access using the current kube context; gRPC is optional for direct Jangar access.

## Install

### npm

```bash
npm install -g @proompteng/agentctl
npx @proompteng/agentctl --help
```

### Homebrew

```bash
brew install proompteng/tap/agentctl
```

## Modes
- **Kube mode (default):** uses kubeconfig + context and talks to the Kubernetes API directly.
- **gRPC mode (optional):** uses the Jangar gRPC endpoint.

## Configuration

The CLI reads configuration from `~/.config/agentctl/config.json` (or `$XDG_CONFIG_HOME/agentctl/config.json`).

Supported fields:

```json
{
  "address": "agents-grpc.agents.svc.cluster.local:50051",
  "namespace": "agents",
  "token": "optional-shared-token",
  "kubeconfig": "/path/to/kubeconfig",
  "context": "my-context"
}
```

Environment overrides:

- `AGENTCTL_SERVER` (preferred)
- `AGENTCTL_ADDRESS`
- `AGENTCTL_NAMESPACE`
- `AGENTCTL_TOKEN`
- `AGENTCTL_TLS` (`1` to enable TLS)
- `AGENTCTL_KUBECONFIG`
- `AGENTCTL_CONTEXT`
- `JANGAR_GRPC_ADDRESS` (server-side default if set)
- `AGENTCTL_CA_CERT` (path to CA cert, optional)
- `AGENTCTL_CLIENT_CERT` / `AGENTCTL_CLIENT_KEY` (mTLS, optional)

## Usage

```bash
agentctl version
agentctl version --client
agentctl config view
agentctl config set --namespace agents --address 127.0.0.1:50051
agentctl --grpc --server 127.0.0.1:50051 status

agentctl agent list
agentctl agent get <name>
agentctl agent describe <name>
agentctl agent watch --interval 5
agentctl agent apply -f agent.yaml
agentctl agent delete <name>

agentctl impl list
agentctl impl create --text "..." --summary "..." --source provider=github,externalId=...,url=...
agentctl impl describe <name>
agentctl impl watch
agentctl impl apply -f impl.yaml
agentctl impl delete <name>

agentctl source list
agentctl source get <name>
agentctl source describe <name>
agentctl source watch
agentctl source apply -f source.yaml
agentctl source delete <name>

agentctl memory list
agentctl memory get <name>
agentctl memory describe <name>
agentctl memory watch
agentctl memory apply -f memory.yaml
agentctl memory delete <name>

agentctl orchestration list
agentctl orchestration get <name>
agentctl orchestration describe <name>
agentctl orchestration apply -f orchestration.yaml

agentctl orchestrationrun list
agentctl orchestrationrun get <name>
agentctl orchestrationrun describe <name>
agentctl orchestrationrun apply -f orchestration-run.yaml

agentctl tool list
agentctl tool get <name>
agentctl tool describe <name>
agentctl tool apply -f tool.yaml

agentctl signal list
agentctl signal get <name>
agentctl signal describe <name>
agentctl signal apply -f signal.yaml

agentctl schedule list
agentctl schedule get <name>
agentctl schedule describe <name>
agentctl schedule apply -f schedule.yaml

agentctl artifact list
agentctl artifact get <name>
agentctl artifact describe <name>
agentctl artifact apply -f artifact.yaml

agentctl workspace list
agentctl workspace get <name>
agentctl workspace describe <name>
agentctl workspace apply -f workspace.yaml

agentctl run submit --agent <name> --impl <name> --runtime <type>
agentctl run list
agentctl run get <name>
agentctl run describe <name>
agentctl run status <name>
agentctl run watch
agentctl run wait <name>
agentctl run logs <name> --follow
agentctl run cancel <name>
```

By default, `agentctl` targets the in-cluster service address `agents-grpc.agents.svc.cluster.local:50051` in the
`agents` namespace. Use `--namespace`/`-n` to override the namespace and `--server` (or `--address`) for
port-forwarded access. `--output` supports `table` (default), `json`, and `yaml`; `describe` defaults to `yaml` when
`--output` is omitted.

Port-forward example:

```bash
kubectl -n agents port-forward svc/agents-grpc 50051:50051
agentctl --server 127.0.0.1:50051 status
```

## Build

```bash
bun run build         # builds dist/agentctl.js
bun run build:bin     # builds dist/agentctl-<os>-<arch> + dist/agentctl for host
bun run build:bins    # builds all platform binaries
bun run build:release # builds archives + checksums in dist/release
```

## Release (npm + Homebrew)

1. Build binaries for each target platform:

```bash
bun run build:release
```

2. Publish npm package:

```bash
npm publish --access public
```

3. Upload `dist/release` artifacts to a GitHub release and update the Homebrew formula.
   The build writes a ready-to-commit formula at `dist/release/agentctl.rb` when all targets are built.
