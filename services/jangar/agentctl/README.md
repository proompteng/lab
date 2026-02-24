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
brew tap proompteng/tap
brew install proompteng/tap/agentctl
```

## Modes

- **Kube mode (default):** uses kubeconfig + context and shells out to `kubectl` (JSON output). Requires `kubectl` on PATH.
- **gRPC mode (optional):** uses the Jangar gRPC endpoint; enable with `--grpc` or `AGENTCTL_MODE=grpc`.

## Quickstart

### Kube mode (default)

```bash
agentctl status
agentctl get agent
agentctl get impl
```

### gRPC mode

```bash
kubectl -n agents port-forward svc/agents-grpc 50051:50051
agentctl --grpc --server 127.0.0.1:50051 status
```

### Help & discovery

```bash
agentctl help
agentctl examples
agentctl help run
agentctl get --help
```

## Configuration

The CLI reads configuration from `~/.config/agentctl/config.json` (or `$XDG_CONFIG_HOME/agentctl/config.json`).

`agentctl config view` masks tokens by default; use `--show-secrets` to display them.

Supported fields:

```json
{
  "address": "agents-grpc.agents.svc.cluster.local:50051",
  "namespace": "agents",
  "token": "optional-shared-token",
  "tls": false,
  "kubeconfig": "/path/to/kubeconfig",
  "context": "my-context"
}
```

Environment overrides:

- `AGENTCTL_SERVER` (preferred)
- `AGENTCTL_ADDRESS`
- `AGENTCTL_MODE` (`grpc` or `kube`)
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
agentctl examples
agentctl version
agentctl version --client
agentctl auth login
agentctl auth status
agentctl config view
agentctl config view --show-secrets
agentctl config init
agentctl config set --namespace agents --address 127.0.0.1:50051
agentctl config set --tls
agentctl --grpc --server 127.0.0.1:50051 status
agentctl completion install zsh

agentctl get agent
agentctl get agent <name>
agentctl describe agent <name>
agentctl list agent --selector app=demo
agentctl watch agent --interval 5
agentctl apply -f agent.yaml
agentctl delete agent <name> --yes
agentctl explain agent

agentctl get impl
agentctl create impl --text "..." --summary "..." --source provider=github,externalId=...,url=...
agentctl create impl --text @impl.md --summary "..."
agentctl create impl --text - --summary "..." < impl.md
agentctl init impl --apply
agentctl describe impl <name>
agentctl watch impl
agentctl apply -f impl.yaml
agentctl delete impl <name> --yes

agentctl get source
agentctl get source <name>
agentctl describe source <name>
agentctl watch source
agentctl apply -f source.yaml
agentctl delete source <name> --yes

agentctl get memory
agentctl get memory <name>
agentctl describe memory <name>
agentctl watch memory
agentctl apply -f memory.yaml
agentctl delete memory <name> --yes

agentctl get orchestration
agentctl get orchestration <name>
agentctl describe orchestration <name>
agentctl apply -f orchestration.yaml

agentctl get orchestrationrun
agentctl get orchestrationrun <name>
agentctl describe orchestrationrun <name>
agentctl apply -f orchestration-run.yaml

agentctl get tool
agentctl get tool <name>
agentctl describe tool <name>
agentctl apply -f tool.yaml

agentctl get signal
agentctl get signal <name>
agentctl describe signal <name>
agentctl apply -f signal.yaml

agentctl get schedule
agentctl get schedule <name>
agentctl describe schedule <name>
agentctl apply -f schedule.yaml

agentctl get artifact
agentctl get artifact <name>
agentctl describe artifact <name>
agentctl apply -f artifact.yaml

agentctl get workspace
agentctl get workspace <name>
agentctl describe workspace <name>
agentctl apply -f workspace.yaml

agentctl run submit --agent <name> --impl <name> --runtime <type>
agentctl init run --apply --wait
agentctl run codex --prompt "Summarize repo" --agent <name> --runtime workflow --wait
agentctl get run
agentctl get run <name>
agentctl describe run <name>
agentctl list run --phase Succeeded
agentctl watch run --runtime workflow
agentctl run wait <name>
agentctl run logs <name> --follow
agentctl run cancel <name>
```

Notes:

- `apply` accepts `-f -` to read manifests from stdin.
- `create impl --text` accepts inline text, `@file`, or `-` for stdin.
- Use `--dry-run` with `apply` or `delete` to preview changes.
- Use `--yes` to skip confirmation prompts (required for apply/delete in non-interactive contexts).

By default, `agentctl` targets the Kubernetes API using your kube context. Use `--grpc` (or `AGENTCTL_MODE=grpc`) plus
`--server` (or `--address`) to target the Jangar gRPC endpoint. `--output` supports `table` (default), `wide`, `json`,
`yaml`, `yaml-stream`, and `text`; `describe` defaults to `yaml` when `--output` is omitted.

Port-forward example:

```bash
kubectl -n agents port-forward svc/agents-grpc 50051:50051
agentctl --grpc --server 127.0.0.1:50051 status
```

## Migration guide (breaking changes)

- `agentctl <resource> list` → `agentctl get <resource>` (or `agentctl list <resource>`)
- `agentctl <resource> get <name>` → `agentctl get <resource> <name>`
- `agentctl <resource> describe <name>` → `agentctl describe <resource> <name>`
- `agentctl <resource> watch` → `agentctl watch <resource>`
- `agentctl <resource> apply -f <file>` → `agentctl apply -f <file>`
- `agentctl <resource> delete <name>` → `agentctl delete <resource> <name> --yes`
- `agentctl impl init` → `agentctl init impl`
- `agentctl impl create` → `agentctl create impl`
- `agentctl run list/get/describe/watch` → `agentctl list|get|describe|watch run`
- `agentctl run init` → `agentctl init run`

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
