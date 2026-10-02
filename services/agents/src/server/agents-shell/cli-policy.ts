const READ_ONLY_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'describe'])
const READ_ONLY_KUBECTL_COMMANDS = new Set([
  'api-resources',
  'api-versions',
  'auth',
  'cluster-info',
  'describe',
  'events',
  'explain',
  'get',
  'logs',
  'top',
  'version',
])
const READ_ONLY_KUBECTL_AUTH_COMMANDS = new Set(['can-i', 'whoami'])
const READ_ONLY_KUBECTL_ROLLOUT_COMMANDS = new Set(['history', 'status'])

export const normalizeCliArgs = (toolName: string, rawArgs: readonly string[]) => {
  const args = rawArgs.map((arg) => arg.trim()).filter(Boolean)
  if (args.length === 0) throw new Error(`${toolName} args must not be empty`)
  return args
}

export const requireReadOnlyGitArgs = (args: readonly string[]) => {
  const command = args[0]
  if (READ_ONLY_GIT_COMMANDS.has(command)) return
  throw new Error(`git supports read-only repository inspection only; use git_write for git ${command}`)
}

const afterNamespaceFlags = (args: readonly string[], start: number) => {
  let index = start
  while (index < args.length) {
    const flag = args[index]
    let namespace: string | undefined
    if (flag === '-n' || flag === '--namespace') {
      namespace = args[index + 1]
      index += 2
    } else if (flag.startsWith('--namespace=')) {
      namespace = flag.slice('--namespace='.length)
      index += 1
    } else if (flag.startsWith('-n')) {
      namespace = flag.slice(2)
      index += 1
    } else break
    if (!namespace || namespace.startsWith('-')) throw new Error('kubectl namespace requires a value')
  }
  return index
}

export const requireReadOnlyKubectlArgs = (args: readonly string[]) => {
  const index = afterNamespaceFlags(args, 0)
  const command = args[index]
  const subcommand = args[afterNamespaceFlags(args, index + 1)] ?? ''
  if (READ_ONLY_KUBECTL_COMMANDS.has(command)) {
    if (command === 'auth' && !READ_ONLY_KUBECTL_AUTH_COMMANDS.has(subcommand)) {
      throw new Error(
        'kubectl auth supports read-only subcommands only; use kubectl_admin for other kubectl auth calls',
      )
    }
    return
  }
  if (command === 'rollout' && READ_ONLY_KUBECTL_ROLLOUT_COMMANDS.has(subcommand)) return
  throw new Error(`kubectl supports read-only cluster inspection only; use kubectl_admin for kubectl ${command}`)
}
