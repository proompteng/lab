const globalFlags = `Global flags:
  --kube                 Force Kubernetes API mode (default).
  --grpc                 Force gRPC mode.
  --namespace, -n <ns>    Namespace (default: agents).
  --server, --address     gRPC address (use with --grpc).
  --token <token>         gRPC bearer token.
  --tls / --no-tls        Enable/disable TLS for gRPC.
  --kubeconfig <path>     Kubeconfig path.
  --context <name>        Kube context name.
  --output, -o <fmt>      Output format: table|wide|json|yaml|yaml-stream|text.
  --yes, -y               Skip confirmation prompts.
  --no-input              Disable interactive prompts.
  --color / --no-color    Enable/disable color output.
  --pager / --no-pager    Enable/disable pager output.
`

export const renderShortHelp = (version: string) => `agentctl ${version}

Default transport: Kubernetes API (kube). Use --grpc for direct Jangar access.

Quickstart:
  agentctl status
  agentctl get agent
  agentctl init impl --apply
  agentctl init run --apply --wait

Common tasks:
  agentctl run submit --agent <name> --impl <name> --runtime <type>
  agentctl run logs <name> --follow
  agentctl get run --phase Succeeded

Discover more:
  agentctl help all
  agentctl examples [topic]
  agentctl completion install <bash|zsh|fish>

${globalFlags}`

export const renderTopicHelp = (topic: string) => {
  const normalized = topic.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'run') {
    return `Run commands:
  agentctl run submit --agent <name> --impl <name> --runtime <type>
  agentctl init run --apply --wait
  agentctl run codex --prompt "<task>" --agent <name> --runtime workflow --wait
  agentctl get run --phase Succeeded
  agentctl run logs <name> --follow
  agentctl run wait <name>
`
  }
  if (normalized === 'impl') {
    return `ImplementationSpec:
  agentctl init impl --apply
  agentctl create impl --text @spec.md --summary "..."
  agentctl get impl
`
  }
  if (normalized === 'config') {
    return `Config:
  agentctl config view
  agentctl config set --namespace agents --kubeconfig ~/.kube/config
  agentctl config set --server 127.0.0.1:50051 --token <token> --tls
  agentctl config init
`
  }
  if (normalized === 'init') {
    return `Init:
  agentctl init impl --apply
  agentctl init run --apply --wait
`
  }
  if (normalized === 'create') {
    return `Create:
  agentctl create impl --text @spec.md --summary "..."
`
  }
  if (normalized === 'auth') {
    return `Auth:
  agentctl auth login
  agentctl auth status
  agentctl auth logout
`
  }
  if (normalized === 'completion') {
    return `Completion:
  agentctl completion <bash|zsh|fish>
  agentctl completion install <bash|zsh|fish>
`
  }
  return null
}

export const renderGlobalFlags = () => globalFlags
