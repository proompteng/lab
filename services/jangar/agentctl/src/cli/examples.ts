export const renderExamples = (topic?: string) => {
  const normalized = topic?.trim().toLowerCase()
  if (!normalized) {
    return `Examples:
  agentctl status
  agentctl agent list
  agentctl impl init --apply
  agentctl run submit --agent demo --impl demo --runtime job --wait
  agentctl run logs demo-xxxx --follow
  agentctl run codex --prompt "Summarize repo" --agent demo --runtime workflow --wait
  agentctl completion install zsh
`
  }

  if (normalized === 'run') {
    return `Run examples:
  agentctl run submit --agent demo --impl demo --runtime workflow --wait
  agentctl run list --phase Succeeded
  agentctl run logs demo-xxxx --follow
`
  }
  if (normalized === 'impl') {
    return `ImplementationSpec examples:
  agentctl impl init --apply
  agentctl impl create --text @spec.md --summary "Implement feature" --source provider=manual,externalId=demo
`
  }
  if (normalized === 'config') {
    return `Config examples:
  agentctl config view
  agentctl config set --namespace agents
  agentctl config set --server 127.0.0.1:50051 --token <token> --tls
`
  }
  if (normalized === 'completion') {
    return `Completion examples:
  agentctl completion zsh
  agentctl completion install bash
`
  }

  return `No examples for ${topic}. Try: run, impl, config, completion.`
}
