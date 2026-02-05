#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

type EventPayload = Record<string, unknown>
type PrRateLimitConfig = {
  windowSeconds: number
  maxRequests: number
  backoffSeconds?: number
}

const DEFAULT_WORKDIR = '/workspace/repo'
const PR_RATE_LIMIT_STATE_PATH = '/tmp/jangar-pr-rate-limits.json'
const DEFAULT_TOKEN_PATHS = [
  process.env.VCS_TOKEN_PATH,
  process.env.GITHUB_TOKEN_PATH,
  process.env.GH_TOKEN_PATH,
  '/var/run/secrets/agents/vcs/token',
  '/var/run/secrets/github/token',
  '/var/run/secrets/agents/github/token',
].filter(Boolean) as string[]

const readToken = () => {
  if (process.env.VCS_TOKEN?.trim()) return process.env.VCS_TOKEN.trim()
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim()
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim()
  for (const path of DEFAULT_TOKEN_PATHS) {
    if (!path) continue
    if (!existsSync(path)) continue
    const raw = readFileSync(path, 'utf8').trim()
    if (raw) return raw
  }
  return ''
}

const runSync = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`)
  }
}

const runCapture = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(`${command} ${args.join(' ')} failed: ${err || `exit ${result.status ?? 'unknown'}`}`)
  }
  return (result.stdout ?? '').trim()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const parsePrRateLimits = () => {
  const raw = process.env.VCS_PR_RATE_LIMITS?.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, PrRateLimitConfig>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[codex-implement] invalid VCS_PR_RATE_LIMITS JSON: ${message}`)
    return null
  }
}

const resolvePrRateLimitConfig = (provider: string) => {
  const limits = parsePrRateLimits()
  if (!limits) return null
  const normalized = provider.trim().toLowerCase()
  const entry = limits[normalized] ?? limits.default
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.windowSeconds !== 'number' || typeof entry.maxRequests !== 'number') return null
  if (entry.windowSeconds <= 0 || entry.maxRequests <= 0) return null
  return entry
}

const readPrRateLimitState = () => {
  if (!existsSync(PR_RATE_LIMIT_STATE_PATH)) return {}
  try {
    const raw = readFileSync(PR_RATE_LIMIT_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, { timestamps?: number[] }>
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const writePrRateLimitState = (state: Record<string, { timestamps: number[] }>) => {
  try {
    mkdirSync('/tmp', { recursive: true })
    writeFileSync(PR_RATE_LIMIT_STATE_PATH, JSON.stringify(state))
  } catch {
    // best effort
  }
}

const enforcePrRateLimit = async (provider: string, config: PrRateLimitConfig) => {
  const windowMs = Math.max(config.windowSeconds, 1) * 1000
  const maxRequests = Math.max(config.maxRequests, 1)
  const minSpacingMs = Math.ceil(windowMs / maxRequests)

  for (;;) {
    const now = Date.now()
    const state = readPrRateLimitState()
    const entry = state[provider] ?? { timestamps: [] }
    const recent = (entry.timestamps ?? []).filter((timestamp) => now - timestamp < windowMs)
    let waitMs = 0

    if (recent.length >= maxRequests) {
      const oldest = recent[0]
      waitMs = Math.max(oldest + windowMs - now, 0)
    } else if (recent.length > 0) {
      const last = recent[recent.length - 1]
      const spacing = minSpacingMs - (now - last)
      if (spacing > 0) waitMs = spacing
    }

    if (waitMs <= 0) {
      recent.push(now)
      state[provider] = { timestamps: recent }
      writePrRateLimitState(state)
      return
    }

    const jitter = Math.floor(Math.random() * 500)
    const delayMs = waitMs + jitter
    console.log(
      `[codex-implement] PR rate limit active for ${provider}; waiting ${Math.ceil(delayMs / 1000)}s before retrying`,
    )
    await sleep(delayMs)
  }
}

const isRateLimitError = (output: string) =>
  /rate limit|secondary rate limit|too many requests|http 429/.test(output.toLowerCase())

const runPrCreateWithBackoff = async (
  args: string[],
  env: NodeJS.ProcessEnv,
  config: PrRateLimitConfig | null,
) => {
  if (!config) {
    runSync('gh', args, { env })
    return
  }

  const maxAttempts = 3
  const baseBackoffMs = Math.max(config.backoffSeconds ?? 30, 0) * 1000

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.status === 0) return

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    if (attempt < maxAttempts && isRateLimitError(output)) {
      const jitter = baseBackoffMs > 0 ? Math.floor(Math.random() * 1000) : 0
      const delayMs = baseBackoffMs * attempt + jitter
      if (delayMs > 0) {
        console.log(
          `[codex-implement] PR creation rate limited; backing off ${Math.ceil(delayMs / 1000)}s (attempt ${attempt}/${maxAttempts})`,
        )
        await sleep(delayMs)
      }
      continue
    }

    throw new Error(`gh pr create failed: ${output || `exit ${result.status ?? 'unknown'}`}`)
  }
}

const resolveVcsProvider = () => (process.env.VCS_PROVIDER ?? '').trim().toLowerCase()

const resolveVcsUsername = () => {
  if (process.env.VCS_USERNAME?.trim()) return process.env.VCS_USERNAME.trim()
  const provider = resolveVcsProvider()
  if (provider === 'gitlab') return 'oauth2'
  if (provider === 'bitbucket') return 'x-token-auth'
  if (provider === 'github') return 'x-access-token'
  return 'git'
}

const resolveCloneProtocol = () => {
  const raw = (process.env.VCS_CLONE_PROTOCOL ?? '').trim().toLowerCase()
  if (raw === 'ssh' || raw === 'https') return raw
  if (process.env.VCS_SSH_KEY_PATH) return 'ssh'
  return 'https'
}

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    const pathname = url.pathname.replace(/\/?$/, '/')
    return {
      protocol: url.protocol,
      host: url.host,
      pathname,
    }
  } catch {
    return null
  }
}

const resolveBaseUrl = () => {
  const raw = process.env.VCS_CLONE_BASE_URL || process.env.VCS_WEB_BASE_URL || ''
  const normalized = normalizeBaseUrl(raw)
  if (normalized) return normalized
  const provider = resolveVcsProvider()
  if (provider === 'github' || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return normalizeBaseUrl('https://github.com')
  }
  return null
}

const buildRepoUrl = (repository: string) => {
  const protocol = resolveCloneProtocol()
  const base = resolveBaseUrl()
  const provider = resolveVcsProvider()
  const prefix = base?.pathname ? base.pathname.replace(/\/+$/, '') : ''
  if (protocol === 'ssh') {
    const host = process.env.VCS_SSH_HOST?.trim() || base?.host || ''
    const user = process.env.VCS_SSH_USER?.trim() || 'git'
    if (!host) return ''
    return `ssh://${user}@${host}${prefix}/${repository}.git`
  }

  const host = base?.host || (provider === 'github' ? 'github.com' : '')
  const scheme = base?.protocol || 'https:'
  if (!host) return ''
  return `${scheme}//${host}${prefix}/${repository}.git`
}

const ensureAskpass = (env: NodeJS.ProcessEnv, token: string) => {
  if (env.GIT_ASKPASS) return
  const askpassPath = '/tmp/git-askpass.sh'
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$GIT_ASKPASS_USERNAME" ;;
  *Password*) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
  *) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
esac
`
  mkdirSync('/tmp', { recursive: true })
  writeFileSync(askpassPath, script, { mode: 0o700 })
  env.GIT_ASKPASS = askpassPath
  env.GIT_ASKPASS_TOKEN = token
  if (!env.GIT_ASKPASS_USERNAME) {
    env.GIT_ASKPASS_USERNAME = resolveVcsUsername()
  }
  if (!env.GIT_TERMINAL_PROMPT) {
    env.GIT_TERMINAL_PROMPT = '0'
  }
}

const configureGitEnv = (env: NodeJS.ProcessEnv) => {
  const token = readToken()
  if (token) {
    env.VCS_TOKEN = env.VCS_TOKEN ?? token
    if (resolveVcsProvider() === 'github') {
      env.GH_TOKEN = env.GH_TOKEN ?? token
      env.GITHUB_TOKEN = env.GITHUB_TOKEN ?? token
    }
    ensureAskpass(env, token)
  }

  if (process.env.VCS_SSH_KEY_PATH && !env.GIT_SSH_COMMAND) {
    const args = ['ssh', '-i', process.env.VCS_SSH_KEY_PATH, '-o', 'IdentitiesOnly=yes']
    if (process.env.VCS_SSH_KNOWN_HOSTS_PATH) {
      args.push('-o', `UserKnownHostsFile=${process.env.VCS_SSH_KNOWN_HOSTS_PATH}`, '-o', 'StrictHostKeyChecking=yes')
    } else {
      args.push('-o', 'StrictHostKeyChecking=accept-new')
    }
    env.GIT_SSH_COMMAND = args.join(' ')
  }
}

const sanitizeBranch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 62) || 'codex/agent-run'

const getString = (payload: EventPayload, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const renderTemplate = (template: string, context: Record<string, string>) =>
  template.replace(/{{\s*([^}]+)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey).trim()
    return context[key] ?? ''
  })

const main = async () => {
  const eventPath = process.argv[2]
  if (!eventPath) {
    throw new Error('Usage: codex-implement <event.json>')
  }

  const raw = readFileSync(eventPath, 'utf8')
  const payload = JSON.parse(raw) as EventPayload

  const prompt = getString(payload, ['prompt', 'text', 'summary'])
  if (!prompt) throw new Error('Event payload is missing prompt or text')

  const repository = getString(payload, ['repository', 'repo', 'issueRepository'])
  if (!repository) throw new Error('Event payload is missing repository')

  const issueNumber = getString(payload, ['issueNumber', 'issue_number', 'issue', 'issueId'])
  const issueTitle = getString(payload, ['issueTitle', 'title'])
  const issueUrl = getString(payload, ['issueUrl', 'url'])

  const workdir = process.env.CODEX_WORKDIR?.trim() || DEFAULT_WORKDIR
  mkdirSync(workdir, { recursive: true })

  const env = { ...process.env }
  configureGitEnv(env)

  const repoUrl = buildRepoUrl(repository)
  if (!repoUrl) {
    throw new Error('Unable to resolve repository clone URL. Configure VCS_CLONE_BASE_URL or VCS_WEB_BASE_URL.')
  }

  const gitDir = join(workdir, '.git')
  if (existsSync(gitDir)) {
    runSync('git', ['-C', workdir, 'remote', 'set-url', 'origin', repoUrl], { env })
    runSync('git', ['-C', workdir, 'fetch', '--prune', 'origin'], { env })
  } else {
    runSync('git', ['clone', repoUrl, workdir], { env })
  }

  let defaultBranch = process.env.VCS_BASE_BRANCH?.trim() || ''
  if (!defaultBranch) {
    try {
      const output = runCapture('git', ['-C', workdir, 'remote', 'show', 'origin'], { env })
      const match = output.match(/HEAD branch:\s+(.+)/)
      if (match?.[1]) {
        defaultBranch = match[1].trim()
      }
    } catch {
      // ignore
    }
  }
  if (!defaultBranch) {
    try {
      const output = runCapture('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], { env })
      const match = output.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/)
      if (match?.[1]) {
        defaultBranch = match[1].trim()
      }
    } catch {
      // ignore
    }
  }
  if (!defaultBranch) defaultBranch = 'main'

  runSync('git', ['-C', workdir, 'fetch', 'origin', defaultBranch], { env })
  runSync('git', ['-C', workdir, 'checkout', defaultBranch], { env })
  runSync('git', ['-C', workdir, 'pull', '--ff-only', 'origin', defaultBranch], { env })

  const headBranch = process.env.VCS_HEAD_BRANCH?.trim() || sanitizeBranch(`codex/agents/${issueNumber || Date.now()}`)
  runSync('git', ['-C', workdir, 'checkout', '-B', headBranch], { env })

  const codexArgs = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--cd',
    workdir,
  ]

  const codexResult = spawnSync('codex', codexArgs, {
    env,
    input: `${prompt}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (codexResult.status !== 0) {
    throw new Error(`codex exec failed with exit ${codexResult.status ?? 'unknown'}`)
  }

  const changed = runCapture('git', ['-C', workdir, 'status', '--porcelain'], { env })
  if (!changed) {
    throw new Error('codex produced no changes; aborting')
  }

  const writeEnabled = (process.env.VCS_WRITE_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
  if (!writeEnabled) {
    console.log('VCS write disabled; skipping commit/push/PR.')
    return
  }

  if (process.env.VCS_COMMIT_AUTHOR_NAME?.trim()) {
    runSync('git', ['-C', workdir, 'config', 'user.name', process.env.VCS_COMMIT_AUTHOR_NAME.trim()], { env })
  }
  if (process.env.VCS_COMMIT_AUTHOR_EMAIL?.trim()) {
    runSync('git', ['-C', workdir, 'config', 'user.email', process.env.VCS_COMMIT_AUTHOR_EMAIL.trim()], { env })
  }

  runSync('git', ['-C', workdir, 'add', '-A'], { env })
  const commitTitle = issueTitle || `codex: update ${repository}`
  const commitMessage = issueNumber ? `${commitTitle} (#${issueNumber})` : commitTitle
  runSync('git', ['-C', workdir, 'commit', '-m', commitMessage], { env })

  runSync('git', ['-C', workdir, 'push', '--set-upstream', 'origin', headBranch], { env })

  const prFlag = process.env.VCS_PULL_REQUESTS_ENABLED?.trim().toLowerCase()
  const shouldCreatePr = prFlag ? prFlag === 'true' : true
  if (!shouldCreatePr) {
    console.log('PR creation disabled; finished after push.')
    return
  }

  const provider = resolveVcsProvider()
  if (provider !== 'github' && provider !== '') {
    console.log('PR creation skipped (provider is not GitHub).')
    return
  }

  const templateContext: Record<string, string> = {
    repository,
    issueNumber,
    issueTitle,
    issueUrl,
    baseBranch: defaultBranch,
    headBranch,
    prompt,
  }
  const prTitleTemplate = process.env.VCS_PR_TITLE_TEMPLATE?.trim()
  const prBodyTemplate = process.env.VCS_PR_BODY_TEMPLATE?.trim()
  const prTitle = prTitleTemplate
    ? renderTemplate(prTitleTemplate, templateContext)
    : issueTitle || `Codex: ${repository}`
  const prBodyLines = [issueNumber ? `Closes #${issueNumber}` : '', issueUrl ? `Source: ${issueUrl}` : ''].filter(
    Boolean,
  )
  const prBodyFallback = prBodyLines.length > 0 ? prBodyLines.join('\n') : 'Generated by codex-implement.'
  const prBody = prBodyTemplate ? renderTemplate(prBodyTemplate, templateContext) : prBodyFallback

  const prArgs = [
    'pr',
    'create',
    '--repo',
    repository,
    '--title',
    prTitle,
    '--body',
    prBody,
    '--head',
    headBranch,
    '--base',
    defaultBranch,
  ]
  if (process.env.VCS_PR_DRAFT?.trim().toLowerCase() === 'true') {
    prArgs.push('--draft')
  }
  const providerKey = provider || 'default'
  const prRateLimitConfig = resolvePrRateLimitConfig(providerKey)
  if (prRateLimitConfig) {
    await enforcePrRateLimit(providerKey, prRateLimitConfig)
  }
  await runPrCreateWithBackoff(prArgs, env, prRateLimitConfig)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
