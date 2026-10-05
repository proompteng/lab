const READ_ONLY_GIT_COMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'describe',
])
const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '--paginate', '--no-optional-locks', '--literal-pathspecs'])
const LS_REMOTE_FLAGS = new Set([
  '-q',
  '--quiet',
  '--no-quiet',
  '-h',
  '--heads',
  '-b',
  '--branches',
  '--no-branches',
  '-t',
  '--tags',
  '--no-tags',
  '--refs',
  '--no-refs',
  '--get-url',
  '--no-get-url',
  '--exit-code',
  '--no-exit-code',
  '--symref',
  '--no-symref',
  '--no-sort',
])
const KUBECTL_GLOBAL_VALUES = new Set([
  '-n',
  '--namespace',
  '--context',
  '--cluster',
  '--user',
  '--kubeconfig',
  '-s',
  '--server',
  '--request-timeout',
  '--as',
  '--as-group',
  '--as-uid',
  '--token',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--tls-server-name',
  '--cache-dir',
  '--v',
  '-v',
  '--vmodule',
])
const KUBECTL_GLOBAL_FLAGS = new Set([
  '--insecure-skip-tls-verify',
  '--match-server-version',
  '--disable-compression',
  '--warnings-as-errors',
])
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
  if (rawArgs.length === 0) throw new Error(`${toolName} args must not be empty`)
  return Array.from(rawArgs)
}

const commandIndex = (args: readonly string[], values: ReadonlySet<string>, flags: ReadonlySet<string>, start = 0) => {
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') return index + 1
    if (!arg.startsWith('-')) return index
    const [option] = arg.split('=', 1)
    if (flags.has(option)) continue
    if (values.has(option)) {
      if (arg.includes('=')) continue
      if (index + 1 === args.length) throw new Error(`missing value for ${arg}`)
      index += 1
      continue
    }
    if (arg.length > 2 && values.has(arg.slice(0, 2)) && arg[1] !== '-') continue
    throw new Error(`unsupported global inspection option: ${arg}`)
  }
  return args.length
}

export const requireReadOnlyGitArgs = (args: readonly string[]) => {
  const index = commandIndex(args, new Set(), GIT_GLOBAL_FLAGS)
  const command = args[index]
  if (command === 'ls-remote') {
    let literal = false
    let repository: string | undefined
    for (let offset = index + 1; offset < args.length; offset += 1) {
      const arg = args[offset]
      if (!literal && arg === '--') {
        literal = true
        continue
      }
      if (!literal && arg.startsWith('-')) {
        if (LS_REMOTE_FLAGS.has(arg) || arg.startsWith('--sort=')) continue
        if (arg === '--sort' && offset + 1 < args.length) {
          offset += 1
          continue
        }
        throw new Error(
          `git ls-remote inspection does not allow option ${arg}; use git_write for executable or transport overrides`,
        )
      }
      repository ??= arg
    }
    if (repository && /^[a-z][a-z0-9+.-]*::/i.test(repository))
      throw new Error('git ls-remote inspection does not allow remote helpers; use git_write')
    return
  }
  if (READ_ONLY_GIT_COMMANDS.has(command)) return
  if (command === 'worktree' && args[index + 1] === 'list') return
  if (command === 'remote' && args.length === index + 2 && ['-v', '--verbose'].includes(args[index + 1])) return
  throw new Error(`git supports read-only repository inspection only; use git_write for git ${command}`)
}

export const requireReadOnlyKubectlArgs = (args: readonly string[]) => {
  const index = commandIndex(args, KUBECTL_GLOBAL_VALUES, KUBECTL_GLOBAL_FLAGS)
  const command = args[index]
  const subcommand = () => args[commandIndex(args, KUBECTL_GLOBAL_VALUES, KUBECTL_GLOBAL_FLAGS, index + 1)]
  if (READ_ONLY_KUBECTL_COMMANDS.has(command)) {
    if (command === 'auth' && !READ_ONLY_KUBECTL_AUTH_COMMANDS.has(subcommand() ?? '')) {
      throw new Error(
        'kubectl auth supports read-only subcommands only; use kubectl_admin for other kubectl auth calls',
      )
    }
    return
  }
  if (command === 'rollout' && READ_ONLY_KUBECTL_ROLLOUT_COMMANDS.has(subcommand() ?? '')) return
  if (command === 'config' && subcommand() === 'current-context') return
  throw new Error(`kubectl supports read-only cluster inspection only; use kubectl_admin for kubectl ${command}`)
}
