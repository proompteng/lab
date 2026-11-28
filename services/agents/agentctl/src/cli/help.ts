export const renderShortHelp = (version: string) => `agentctl ${version}

Default transport: Kubernetes API (kube). Use --grpc for direct Agents gRPC access.

Quickstart:
  agentctl status
  agentctl get agent
  agentctl init impl --apply
  agentctl init run --apply --wait

Common tasks:
  agentctl run submit --agent <name> --impl <name> --runtime <type>
  agentctl run summary <name>
  agentctl run batch --spec runs.yaml --verify --concurrency 8
  agentctl run list --active -o wide

Discover more:
  agentctl --help
  agentctl examples [topic]
  agentctl completion install <bash|zsh|fish>
`

export const renderTopicHelp = (topic: string) => {
  const normalized = topic.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'run') {
    return `Run commands:
  agentctl run submit --agent <name> --impl <name> --runtime <type>
  agentctl init run --apply --wait
  agentctl run codex --prompt-file task.md --repo <owner/repo> --base main --head <branch> --verify
  agentctl run batch --spec runs.yaml [--verify] [--concurrency 8]
  agentctl run list --active -o wide
  agentctl run summary <name> [--json]
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
