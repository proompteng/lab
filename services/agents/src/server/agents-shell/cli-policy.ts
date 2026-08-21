const READ_ONLY_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'describe'])
const GIT_DIFF_RENDERING_COMMANDS = new Set(['diff', 'log', 'show'])
const GIT_SUBMODULE_INSPECTION_COMMANDS = new Set(['status', 'diff', 'log', 'show'])
const readOnlyGitConfig = (hooksPath: string) =>
  [
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.alternateRefsCommand=',
    '-c',
    'gpg.program=',
    '-c',
    'gpg.openpgp.program=',
    '-c',
    'gpg.x509.program=',
    '-c',
    'gpg.ssh.program=',
    '-c',
    'diff.external=',
    '-c',
    'diff.submodule=short',
    '-c',
    'interactive.diffFilter=',
    '-c',
    'status.submoduleSummary=false',
    '-c',
    'submodule.recurse=false',
  ] as const

export const prepareReadOnlyGitRefreshArgs = (hooksPath: string, configOverrides: readonly string[] = []) => [
  '--no-pager',
  ...readOnlyGitConfig(hooksPath),
  ...configOverrides,
  'update-index',
  '-q',
  '--really-refresh',
]
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
const GIT_REPOSITORY_SELECTOR_FLAGS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--work-tree',
])
const GIT_RECURSIVE_SUBMODULE_FLAGS = new Set(['--ignore-submodules', '--recurse-submodules', '--submodule'])
const KUBECTL_CLIENT_OVERRIDE_FLAGS = new Set([
  '--as',
  '--as-group',
  '--as-uid',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--cluster',
  '--context',
  '--insecure-skip-tls-verify',
  '--kubeconfig',
  '--password',
  '--server',
  '--tls-server-name',
  '--token',
  '--user',
  '--username',
])
const KUBECTL_FILE_BACKED_OUTPUT_FORMATS = new Set(['custom-columns-file', 'go-template-file', 'jsonpath-file'])

const rejectsGitGrepPager = (args: readonly string[]) => {
  if (args[0] !== 'grep') return false
  for (const arg of args.slice(1)) {
    if (arg === '--') break
    if (arg.startsWith('--open-files')) return true
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('O')) return true
  }
  return false
}

const rejectsRecursiveSubmoduleInspection = (args: readonly string[]) => {
  for (const arg of args.slice(1)) {
    if (arg === '--') break
    if (
      GIT_RECURSIVE_SUBMODULE_FLAGS.has(arg) ||
      Array.from(GIT_RECURSIVE_SUBMODULE_FLAGS).some((flag) => arg.startsWith(`${flag}=`))
    ) {
      return true
    }
  }
  return false
}

const rejectsKubectlClientOverrides = (args: readonly string[]) =>
  args.some(
    (arg) =>
      KUBECTL_CLIENT_OVERRIDE_FLAGS.has(arg) ||
      Array.from(KUBECTL_CLIENT_OVERRIDE_FLAGS).some((flag) => arg.startsWith(`${flag}=`)) ||
      arg === '-s' ||
      arg.startsWith('-s=') ||
      (arg.startsWith('-s') && !arg.startsWith('--') && arg.length > 2),
  )

const rejectsKubectlFileBackedOutput = (args: readonly string[]) => {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') break
    let output: string | undefined
    if (arg === '-o' || arg === '--output') {
      output = args[index + 1]
      index += 1
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length)
    } else if (arg.startsWith('-o=')) {
      output = arg.slice('-o='.length)
    } else if (arg.startsWith('-o') && !arg.startsWith('--') && arg.length > 2) {
      output = arg.slice(2)
    }
    if (!output) continue
    const format = output.toLowerCase().split('=', 1)[0]
    if (format && KUBECTL_FILE_BACKED_OUTPUT_FORMATS.has(format)) return true
  }
  return false
}

export const normalizeCliArgs = (toolName: string, rawArgs: readonly string[]) => {
  const args = rawArgs.map((arg) => arg.trim()).filter(Boolean)
  if (args.length === 0) throw new Error(`${toolName} args must not be empty`)
  return args
}

export const prepareReadOnlyGitArgs = (
  args: readonly string[],
  hooksPath: string,
  configOverrides: readonly string[] = [],
) => {
  const command = args[0]
  const forbidden = new Set([...GIT_REPOSITORY_SELECTOR_FLAGS, '--ext-diff', '--no-index', '--textconv'])
  if (args.some((arg) => forbidden.has(arg) || Array.from(forbidden).some((flag) => arg.startsWith(`${flag}=`)))) {
    throw new Error('git read inspection rejects repository selectors, config injection, and external command hooks')
  }
  if (rejectsGitGrepPager(args)) {
    throw new Error('git grep read inspection rejects explicit pager commands')
  }
  if (rejectsRecursiveSubmoduleInspection(args)) {
    throw new Error('git read inspection rejects recursive submodule rendering and caller-controlled submodule policy')
  }
  if (!READ_ONLY_GIT_COMMANDS.has(command)) {
    throw new Error(`git supports read-only repository inspection only; use git_write for git ${command}`)
  }
  let commandArgs = GIT_DIFF_RENDERING_COMMANDS.has(command)
    ? [command, '--no-ext-diff', '--no-textconv', ...args.slice(1)]
    : [...args]
  if (GIT_SUBMODULE_INSPECTION_COMMANDS.has(command)) {
    commandArgs = [commandArgs[0], '--ignore-submodules=all', ...commandArgs.slice(1)]
  }
  return ['--no-pager', ...readOnlyGitConfig(hooksPath), ...configOverrides, ...commandArgs]
}

export const requireContainedGitArgs = (args: readonly string[]) => {
  if (
    args.some(
      (arg) =>
        GIT_REPOSITORY_SELECTOR_FLAGS.has(arg) ||
        Array.from(GIT_REPOSITORY_SELECTOR_FLAGS).some((flag) => arg.startsWith(`${flag}=`)),
    )
  ) {
    throw new Error(
      'git_write rejects repository selectors and config injection; select the leased repository with cwd',
    )
  }
}

export const requireReadOnlyKubectlArgs = (args: readonly string[]) => {
  const command = args[0]
  if (rejectsKubectlClientOverrides(args)) {
    throw new Error('kubectl read inspection rejects caller-controlled client authentication and endpoints')
  }
  if (rejectsKubectlFileBackedOutput(args)) {
    throw new Error('kubectl read inspection rejects file-backed output templates')
  }
  if (READ_ONLY_KUBECTL_COMMANDS.has(command)) {
    if (command === 'auth' && !READ_ONLY_KUBECTL_AUTH_COMMANDS.has(args[1] ?? '')) {
      throw new Error(
        'kubectl auth supports read-only subcommands only; use kubectl_admin for other kubectl auth calls',
      )
    }
    return
  }
  if (command === 'rollout' && READ_ONLY_KUBECTL_ROLLOUT_COMMANDS.has(args[1] ?? '')) return
  throw new Error(`kubectl supports read-only cluster inspection only; use kubectl_admin for kubectl ${command}`)
}
