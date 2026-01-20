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

agentctl orchestration list
agentctl orchestration get <name>
agentctl orchestration apply -f orchestration.yaml
agentctl orchestration delete <name>

agentctl orchestration-run list
agentctl orchestration-run get <name>
agentctl orchestration-run submit --orchestration <name> --param key=value
agentctl orchestration-run apply -f orchestration-run.yaml
agentctl orchestration-run delete <name>

agentctl tool list
agentctl tool get <name>
agentctl tool apply -f tool.yaml
agentctl tool delete <name>

agentctl tool-run list
agentctl tool-run get <name>
agentctl tool-run submit --tool <name> --param key=value
agentctl tool-run apply -f tool-run.yaml
agentctl tool-run delete <name>

agentctl signal list
agentctl signal get <name>
agentctl signal apply -f signal.yaml
agentctl signal delete <name>

agentctl signal-delivery list
agentctl signal-delivery get <name>
agentctl signal-delivery apply -f signal-delivery.yaml
agentctl signal-delivery delete <name>

agentctl approval-policy list
agentctl approval-policy get <name>
agentctl approval-policy apply -f approval-policy.yaml
agentctl approval-policy delete <name>

agentctl budget list
agentctl budget get <name>
agentctl budget apply -f budget.yaml
agentctl budget delete <name>

agentctl secret-binding list
agentctl secret-binding get <name>
agentctl secret-binding apply -f secret-binding.yaml
agentctl secret-binding delete <name>

agentctl schedule list
agentctl schedule get <name>
agentctl schedule apply -f schedule.yaml
agentctl schedule delete <name>

agentctl artifact list
agentctl artifact get <name>
agentctl artifact apply -f artifact.yaml
agentctl artifact delete <name>

agentctl workspace list
agentctl workspace get <name>
agentctl workspace apply -f workspace.yaml
agentctl workspace delete <name>

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
   The build writes a ready-to-commit formula at `dist/release/agentctl.rb` when all targets are built.
