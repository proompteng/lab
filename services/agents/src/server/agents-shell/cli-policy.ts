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
const MANUAL_CODEX_REVIEW_REQUEST = /(?:@codex\s+review\b|codex:review-request\b)/i
const GH_PR_COMMENT_COMMAND = /\bgh\s+pr\s+comment\b/i
const GH_API_COMMAND = /\bgh\s+api\b/i
const GH_API_WRITE_METHOD = /(?:^|\s)(?:-X\s+|--method(?:=|\s+))(?:POST|PATCH)(?:\s|$)/i
const GRAPHQL_MUTATION = /\bmutation\b/i

const manualCodexReviewRequestError =
  'manual Codex review comments are disabled; rely on the automatic repository review'

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

export const requireReadOnlyKubectlArgs = (args: readonly string[]) => {
  const command = args[0]
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

export const requireAllowedShellCommand = (command: string) => {
  if (!MANUAL_CODEX_REVIEW_REQUEST.test(command)) return

  const postsPullRequestComment = GH_PR_COMMENT_COMMAND.test(command)
  const writesGithubApi =
    GH_API_COMMAND.test(command) && (GH_API_WRITE_METHOD.test(command) || GRAPHQL_MUTATION.test(command))

  if (postsPullRequestComment || writesGithubApi) {
    throw new Error(manualCodexReviewRequestError)
  }
}
