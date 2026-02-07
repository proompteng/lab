#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

type EventPayload = Record<string, unknown>

const DEFAULT_WORKDIR = '/workspace/repo'
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
  const startSha = runCapture('git', ['-C', workdir, 'rev-parse', 'HEAD'], { env })

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

  const endSha = runCapture('git', ['-C', workdir, 'rev-parse', 'HEAD'], { env })
  const changed = runCapture('git', ['-C', workdir, 'status', '--porcelain'], { env })
  if (!changed && startSha === endSha) {
    throw new Error('codex produced no changes; aborting')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
