# agentctl CLI

`agentctl` is the Jangar gRPC CLI for managing agent primitives. It does not talk to Kubernetes directly; all
operations go through the Jangar gRPC API.

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

## Port-forward for local access

Jangar gRPC is cluster-only. For local usage, port-forward the `agents-grpc` service:

```bash
kubectl -n agents port-forward svc/agents-grpc 50051:50051
agentctl --server 127.0.0.1:50051 status
```

## Configuration

`agentctl` reads `~/.config/agentctl/config.json` (or `$XDG_CONFIG_HOME/agentctl/config.json`).

```json
{
  "address": "agents-grpc.agents.svc.cluster.local:50051",
  "namespace": "agents",
  "token": "optional-shared-token"
}
```

## Usage

```bash
agentctl status
agentctl agent list
agentctl agent describe <name>
agentctl agent watch --interval 5

agentctl impl list
agentctl impl describe <name>

agentctl run submit --agent <name> --impl <name> --runtime <type>
agentctl run status <name>
agentctl run watch
```

## Build (Bun binary)

```bash
bun run --filter @proompteng/agentctl build
bun run --filter @proompteng/agentctl build:bin
```

The build produces `services/jangar/agentctl/dist/agentctl.js` (npm launcher) and
`services/jangar/agentctl/dist/agentctl` (host binary).
