const globalFlags = `Global flags:
  --kube                 Force Kubernetes API mode (default).
  --grpc                 Force gRPC mode.
  --namespace, -n <ns>    Namespace (default: agents).
  --server, --address     gRPC address (use with --grpc).
  --token <token>         gRPC bearer token.
  --tls / --no-tls        Enable/disable TLS for gRPC.
  --kubeconfig <path>     Kubeconfig path.
  --context <name>        Kube context name.
  --output, -o <fmt>      Output format: table|json|yaml.
`

export const renderShortHelp = (version: string) => `agentctl ${version}

Default transport: Kubernetes API (kube). Use --grpc for direct Jangar access.

Quickstart:
  agentctl status
  agentctl agent list
  agentctl impl init --apply
  agentctl run init --apply --wait

Common tasks:
  agentctl run submit --agent <name> --impl <name> --runtime <type>
  agentctl run logs <name> --follow
  agentctl diagnose

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
  agentctl run init --apply --wait
  agentctl run codex --prompt "<task>" --agent <name> --runtime workflow --wait
  agentctl run list --phase Succeeded
  agentctl run logs <name> --follow
  agentctl run wait <name>
`
  }
  if (normalized === 'impl') {
    return `ImplementationSpec:
  agentctl impl init --apply
  agentctl impl create --text @spec.md --summary "..."
  agentctl impl list
`
  }
  if (normalized === 'config') {
    return `Config:
  agentctl config view
  agentctl config set --namespace agents --kubeconfig ~/.kube/config
  agentctl config set --server 127.0.0.1:50051 --token <token> --tls
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
