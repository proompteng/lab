export class WorkflowScopeError extends Error {
  scopes: string[]

  constructor(scopes: string[]) {
    const scopeList = scopes.length > 0 ? scopes.join(', ') : 'none'
    super(
      `GitHub token is missing required scope "workflow" (current scopes: ${scopeList}). Provide a token with workflow scope or set JANGAR_SKIP_GH_SCOPE_CHECK=1 to bypass.`,
    )
    this.name = 'WorkflowScopeError'
    this.scopes = scopes
  }
}

const parseScopes = (scopesHeader: string | null) =>
  scopesHeader
    ?.split(',')
    .map((scope) => scope.trim())
    .filter(Boolean) ?? []

const isTruthyEnv = (value: string | undefined) => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized)
}

const capture = async (cmd: string[]): Promise<string> => {
  const subprocess = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  subprocess.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}\n${stderr.trim()}`)
  }

  return stdout.trim()
}

type EnsureWorkflowScopeOptions = {
  userAgent?: string
  skipEnv?: string[]
}

export const ensureWorkflowScope = async (
  token: string,
  options: EnsureWorkflowScopeOptions = {},
): Promise<{ checked: boolean; scopes: string[] | null }> => {
  const skipEnv = options.skipEnv ?? ['JANGAR_SKIP_GH_SCOPE_CHECK', 'SKIP_GH_SCOPE_CHECK']
  if (skipEnv.some((key) => isTruthyEnv(process.env[key]))) {
    return { checked: false, scopes: null }
  }

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': options.userAgent ?? 'jangar-scripts',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to validate GitHub token scopes (status ${response.status}); supply a token with workflow scope.`,
    )
  }

  const scopesHeader = response.headers.get('x-oauth-scopes')
  if (!scopesHeader) {
    return { checked: false, scopes: null }
  }

  const scopes = parseScopes(scopesHeader)
  if (!scopes.includes('workflow')) {
    throw new WorkflowScopeError(scopes)
  }

  return { checked: true, scopes }
}

type ResolveTokenOptions = {
  requireWorkflow?: boolean
  allowGhCli?: boolean
  ghUserEnv?: string[]
  userAgent?: string
  skipScopeCheckEnv?: string[]
  allowUnknownScopes?: boolean
}

type TokenCandidate = {
  label: string
  get: () => Promise<string | undefined>
}

export const resolveGitHubToken = async (
  options: ResolveTokenOptions = {},
): Promise<{ token: string; source: string }> => {
  const ghUserEnv = options.ghUserEnv ?? ['GH_TOKEN_USER', 'GH_AUTH_USER']
  const allowGhCli = options.allowGhCli ?? true
  const requireWorkflow = options.requireWorkflow ?? false
  const allowUnknownScopes = options.allowUnknownScopes ?? true

  if (!allowGhCli || !Bun.which('gh')) {
    throw new Error('GitHub CLI is required to resolve the token. Install gh and login first.')
  }

  const candidates: TokenCandidate[] = [
    {
      label: 'gh',
      get: async () => {
        const ghUser = ghUserEnv.map((key) => process.env[key]?.trim()).find((value) => value)
        const args = ghUser ? ['gh', 'auth', 'token', '--user', ghUser] : ['gh', 'auth', 'token']
        const token = await capture(args)
        return token.length > 0 ? token : undefined
      },
    },
  ]

  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const token = await candidate.get()
      if (!token) {
        continue
      }

      if (requireWorkflow) {
        try {
          const result = await ensureWorkflowScope(token, {
            userAgent: options.userAgent,
            skipEnv: options.skipScopeCheckEnv,
          })
          if (!result.checked && !allowUnknownScopes) {
            throw new Error('Unable to verify GitHub token scopes; set JANGAR_SKIP_GH_SCOPE_CHECK=1 to bypass.')
          }
        } catch (error) {
          if (candidate.label === 'gh' && error instanceof WorkflowScopeError) {
            try {
              await capture(['gh', 'auth', 'refresh', '--hostname', 'github.com', '--scopes', 'repo,workflow'])
              const refreshed = await candidate.get()
              if (refreshed) {
                await ensureWorkflowScope(refreshed, {
                  userAgent: options.userAgent,
                  skipEnv: options.skipScopeCheckEnv,
                })
                return { token: refreshed, source: candidate.label }
              }
            } catch (refreshError) {
              console.warn(
                `Failed to refresh gh scopes: ${refreshError instanceof Error ? refreshError.message : refreshError}`,
              )
            }
          }
          lastError = error
          console.warn(`GitHub token from ${candidate.label} missing workflow scope; trying next source.`)
          continue
        }
      }

      return { token, source: candidate.label }
    } catch (error) {
      lastError = error
      console.warn(
        `Failed to load GitHub token from ${candidate.label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error('Failed to resolve GitHub token with required workflow scope.')
}
