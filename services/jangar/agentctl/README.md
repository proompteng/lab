# agentctl

`agentctl` is a gRPC CLI for managing Agents primitives through the Jangar controller. It never calls Kubernetes directly; all operations go through the Jangar gRPC API.

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

## Configuration

The CLI reads configuration from `~/.config/agentctl/config.json` (or `$XDG_CONFIG_HOME/agentctl/config.json`).

Supported fields:

```json
{
  "address": "127.0.0.1:50051",
  "namespace": "agents",
  "token": "optional-shared-token"
}
```

Environment overrides:

- `AGENTCTL_ADDRESS`
- `AGENTCTL_NAMESPACE`
- `AGENTCTL_TOKEN`
- `AGENTCTL_TLS` (`1` to enable TLS)
- `AGENTCTL_CA_CERT` (path to CA cert, optional)
- `AGENTCTL_CLIENT_CERT` / `AGENTCTL_CLIENT_KEY` (mTLS, optional)

## Usage

```bash
agentctl version
agentctl config view
agentctl config set --namespace agents

agentctl agent list
agentctl agent get <name>
agentctl agent apply -f agent.yaml
agentctl agent delete <name>

agentctl impl list
agentctl impl create --text "..." --summary "..." --source provider=github,externalId=...,url=...
agentctl impl apply -f impl.yaml
agentctl impl delete <name>

agentctl source list
agentctl source get <name>
agentctl source apply -f source.yaml
agentctl source delete <name>

agentctl memory list
agentctl memory get <name>
agentctl memory apply -f memory.yaml
agentctl memory delete <name>

agentctl run submit --agent <name> --impl <name> --runtime <type>
agentctl run list
agentctl run get <name>
agentctl run logs <name> --follow
agentctl run cancel <name>
```

## Build

```bash
bun run build         # builds dist/agentctl.js
bun run build:bin     # builds dist/agentctl-<os>-<arch> for host
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
