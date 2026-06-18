import { createHash } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { runCommand, runShell } from './command'
import type { AnypiConfig } from './config'
import type {
  AgentRunSpecPayload,
  CiCheck,
  CiWaitResult,
  CommandResult,
  PullRequestResult,
  ValidationResult,
} from './types'

export type GitContext = {
  repository: string
  baseBranch: string
  headBranch: string
  cloneUrl: string
  webUrl: string
  worktree: string
  env: Record<string, string | undefined>
  writeEnabled: boolean
  pullRequestsEnabled: boolean
}

type PullRequestLookup = {
  number: number
  url?: string
}

const envFlag = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms))

const repositoryOwner = (repository: string) => repository.split('/')[0]

export const parsePullRequestList = (raw: string): PullRequestLookup | null => {
  const parsed = JSON.parse(raw || '[]') as unknown
  if (!Array.isArray(parsed)) return null
  const [first] = parsed
  if (!first || typeof first !== 'object') return null
  const record = first as Record<string, unknown>
  const number = typeof record.number === 'number' ? record.number : Number(record.number)
  if (!Number.isFinite(number) || number <= 0) return null
  const url = typeof record.html_url === 'string' ? record.html_url : undefined
  return { number, url }
}

const parsePullRequestResponse = (raw: string): PullRequestLookup => {
  const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
  const number = typeof parsed.number === 'number' ? parsed.number : Number(parsed.number)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('GitHub pull request response did not include a pull request number')
  }
  const url = typeof parsed.html_url === 'string' ? parsed.html_url : undefined
  return { number, url }
}

const writePullRequestInput = async (payload: Record<string, unknown>) => {
  const path = resolve('/tmp', `anypi-pr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  await writeFile(path, `${JSON.stringify(payload)}\n`, 'utf8')
  return path
}

const runGitHubPullRequestMutation = async (
  git: GitContext,
  endpoint: string,
  method: 'POST' | 'PATCH',
  payload: Record<string, unknown>,
) => {
  const inputPath = await writePullRequestInput(payload)
  try {
    return await runCommand('gh', ['api', endpoint, '-X', method, '--input', inputPath], {
      cwd: git.worktree,
      env: git.env,
    })
  } finally {
    await rm(inputPath, { force: true })
  }
}

const buildCloneUrl = (cloneBaseUrl: string, repository: string) => {
  const base = trimTrailingSlash(cloneBaseUrl || 'https://github.com')
  if (base.startsWith('git@')) return `${base}:${repository}.git`
  return `${base}/${repository}.git`
}

const safeRemoveWorktree = async (workspace: string, worktree: string) => {
  const resolvedWorkspace = resolve(workspace)
  const resolvedWorktree = resolve(worktree)
  if (resolvedWorktree === resolvedWorkspace || !resolvedWorktree.startsWith(`${resolvedWorkspace}/`)) {
    throw new Error(`refusing to remove worktree outside workspace: ${resolvedWorktree}`)
  }
  await rm(resolvedWorktree, { recursive: true, force: true })
}

const configureAskpass = async (env: Record<string, string | undefined>) => {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (!token) return env
  env.GH_TOKEN ??= token
  env.GITHUB_TOKEN ??= token
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS_USERNAME ??= 'x-access-token'
  if (!env.GIT_ASKPASS) {
    const askpassPath = '/tmp/anypi-git-askpass.sh'
    await writeFile(
      askpassPath,
      `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$GIT_ASKPASS_USERNAME" ;;
  *Password*) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
  *) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
esac
`,
      { mode: 0o700 },
    )
    await chmod(askpassPath, 0o700)
    env.GIT_ASKPASS = askpassPath
  }
  env.GIT_ASKPASS_TOKEN = token
  return env
}

export const resolveGitContext = async (
  config: AnypiConfig,
  runSpec: AgentRunSpecPayload,
): Promise<GitContext | null> => {
  const repository = process.env.VCS_REPOSITORY || runSpec.vcs?.repository || runSpec.repository
  if (!repository) {
    if (config.allowNoVcs) return null
    throw new Error('VCS_REPOSITORY or run repository metadata is required')
  }
  const baseBranch = process.env.VCS_BASE_BRANCH || runSpec.vcs?.baseBranch || runSpec.base || 'main'
  const runName = runSpec.agentRun?.name ?? 'anypi-run'
  const headBranch = process.env.VCS_HEAD_BRANCH || runSpec.vcs?.headBranch || runSpec.head || `codex/${runName}`
  const cloneBaseUrl = process.env.VCS_CLONE_BASE_URL || runSpec.vcs?.cloneBaseUrl || 'https://github.com'
  const webBaseUrl = process.env.VCS_WEB_BASE_URL || runSpec.vcs?.webBaseUrl || 'https://github.com'
  const env = await configureAskpass({ ...process.env })
  return {
    repository,
    baseBranch,
    headBranch,
    cloneUrl: buildCloneUrl(cloneBaseUrl, repository),
    webUrl: `${trimTrailingSlash(webBaseUrl)}/${repository}`,
    worktree: config.worktree,
    env,
    writeEnabled: envFlag(process.env.VCS_WRITE_ENABLED, runSpec.vcs?.writeEnabled ?? true),
    pullRequestsEnabled: envFlag(process.env.VCS_PULL_REQUESTS_ENABLED, runSpec.vcs?.pullRequestsEnabled ?? true),
  }
}

export const prepareRepository = async (
  config: AnypiConfig,
  git: GitContext | null,
  log: (message: string) => Promise<void>,
) => {
  if (!git) {
    await mkdir(config.worktree, { recursive: true })
    return
  }
  await log(`cloning ${git.repository} ${git.baseBranch} into ${git.worktree}`)
  await safeRemoveWorktree(config.workspace, git.worktree)
  await mkdir(dirname(git.worktree), { recursive: true })
  await runCommand('git', ['clone', '--branch', git.baseBranch, '--single-branch', git.cloneUrl, git.worktree], {
    cwd: config.workspace,
    env: git.env,
  })
  await runCommand('git', ['checkout', '-B', git.headBranch], { cwd: git.worktree, env: git.env })
  const authorName = process.env.VCS_COMMIT_AUTHOR_NAME || process.env.GIT_AUTHOR_NAME
  const authorEmail = process.env.VCS_COMMIT_AUTHOR_EMAIL || process.env.GIT_AUTHOR_EMAIL
  if (authorName) await runCommand('git', ['config', 'user.name', authorName], { cwd: git.worktree, env: git.env })
  if (authorEmail) await runCommand('git', ['config', 'user.email', authorEmail], { cwd: git.worktree, env: git.env })
}

export const gitStatusShort = async (worktree: string, env?: Record<string, string | undefined>) =>
  (await runCommand('git', ['status', '--short'], { cwd: worktree, env })).stdout.trim()

export const gitDiff = async (worktree: string, env?: Record<string, string | undefined>, args: string[] = []) =>
  await runCommand('git', ['diff', ...args], { cwd: worktree, env, allowFailure: true })

export const gitWorktreeContentHash = async (worktree: string, env?: Record<string, string | undefined>) => {
  const hash = createHash('sha256')
  const commands = [
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['diff', '--no-ext-diff', '--binary'],
    ['diff', '--cached', '--no-ext-diff', '--binary'],
  ]
  for (const args of commands) {
    const result = await runCommand('git', args, { cwd: worktree, env, allowFailure: true })
    hash.update(`git ${args.join(' ')}\0${result.exitCode}\0${result.stdout}\0${result.stderr}\0`)
  }

  const untracked = await runCommand('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: worktree,
    env,
    allowFailure: true,
  })
  for (const path of untracked.stdout.split('\0').filter(Boolean).sort()) {
    const result = await runCommand('git', ['hash-object', '--no-filters', path], {
      cwd: worktree,
      env,
      allowFailure: true,
    })
    hash.update(`untracked\0${path}\0${result.exitCode}\0${result.stdout}\0${result.stderr}\0`)
  }

  return hash.digest('hex')
}

const splitLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

export const listChangedFiles = async (git: GitContext) => {
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: git.worktree,
    env: git.env,
    allowFailure: true,
  })
  const commands = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['diff', '--name-only', `origin/${git.baseBranch}...HEAD`],
  ]
  const files: string[] = []
  if (status.exitCode === 0) {
    files.push(
      ...splitLines(status.stdout).map((line) => {
        const path = line.slice(3)
        return path.includes(' -> ') ? (path.split(' -> ').at(-1) ?? path) : path
      }),
    )
  }
  for (const args of commands) {
    const result = await runCommand('git', args, {
      cwd: git.worktree,
      env: git.env,
      allowFailure: true,
    })
    if (result.exitCode === 0) files.push(...splitLines(result.stdout))
  }
  return [...new Set(files)].sort()
}

const restrictedLockfiles = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
const restrictedGeneratedSegments = new Set(['dist', 'build', '_generated'])

export const classifyRestrictedChangedFile = (path: string) => {
  const segments = path.split('/').filter(Boolean)
  const basename = segments.at(-1) ?? path
  if (restrictedLockfiles.has(basename)) return 'lockfile'
  if (segments.some((segment) => restrictedGeneratedSegments.has(segment))) return 'generated-artifact'
  return null
}

const envFlagValue = (value: string | undefined) => {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

const allowsRestrictedFileChanges = (runSpec: AgentRunSpecPayload) =>
  envFlagValue(runSpec.parameters?.allowRestrictedFileChanges) ||
  envFlagValue(runSpec.parameters?.allowGeneratedArtifactChanges) ||
  envFlagValue(runSpec.parameters?.allowLockfileChanges)

export const validateChangedFilePolicy = async (
  git: GitContext,
  runSpec: AgentRunSpecPayload,
): Promise<ValidationResult | null> => {
  if (allowsRestrictedFileChanges(runSpec)) return null
  const started = Date.now()
  const restricted = (await listChangedFiles(git))
    .map((path) => ({ path, reason: classifyRestrictedChangedFile(path) }))
    .filter((entry): entry is { path: string; reason: string } => Boolean(entry.reason))

  if (restricted.length === 0) return null

  return {
    command: 'anypi-policy',
    args: ['restricted-files'],
    cwd: git.worktree,
    exitCode: 1,
    stdout: [
      'Anypi changed generated artifacts or lockfiles without an explicit allow parameter.',
      'Revert these files or set allowRestrictedFileChanges=true only when the task explicitly requires it.',
      '',
      ...restricted.map((entry) => `- ${entry.path} (${entry.reason})`),
    ].join('\n'),
    stderr: '',
    durationMs: Date.now() - started,
    ok: false,
  }
}

export const countCommitsAhead = async (git: GitContext) => {
  const result = await runShell(`git rev-list --count "origin/${git.baseBranch}..HEAD"`, {
    cwd: git.worktree,
    env: git.env,
  })
  return Number.parseInt(result.stdout.trim(), 10) || 0
}

export const commitIfNeeded = async (git: GitContext, message: string): Promise<string | null> => {
  const status = await gitStatusShort(git.worktree, git.env)
  if (status) {
    await runCommand('git', ['add', '-A'], { cwd: git.worktree, env: git.env })
    await runCommand('git', ['commit', '-m', message], { cwd: git.worktree, env: git.env })
  }
  const ahead = await countCommitsAhead(git)
  if (ahead === 0) return null
  return (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: git.worktree, env: git.env })).stdout.trim()
}

export const pushBranch = async (git: GitContext) => {
  if (!git.writeEnabled) throw new Error('VCS write mode is disabled; refusing to push')
  await runCommand('git', ['push', '-u', 'origin', `HEAD:${git.headBranch}`], { cwd: git.worktree, env: git.env })
}

export const createOrUpdatePullRequest = async (
  git: GitContext,
  input: {
    title: string
    body: string
  },
): Promise<PullRequestResult> => {
  if (!git.pullRequestsEnabled) return { enabled: false }
  const owner = repositoryOwner(git.repository)
  const endpoint = `repos/${git.repository}/pulls`
  const view = await runCommand(
    'gh',
    ['api', endpoint, '-X', 'GET', '-f', `head=${owner}:${git.headBranch}`, '-f', 'state=open'],
    {
      cwd: git.worktree,
      env: git.env,
      allowFailure: true,
    },
  )
  const existing = view.exitCode === 0 ? parsePullRequestList(view.stdout) : null
  if (existing) {
    const updated = await runGitHubPullRequestMutation(git, `${endpoint}/${existing.number}`, 'PATCH', {
      title: input.title,
      body: input.body,
    })
    const parsed = parsePullRequestResponse(updated.stdout)
    return { enabled: true, url: parsed.url ?? existing.url, created: false }
  }
  const created = await runGitHubPullRequestMutation(git, endpoint, 'POST', {
    title: input.title,
    body: input.body,
    base: git.baseBranch,
    head: git.headBranch,
  })
  const parsed = parsePullRequestResponse(created.stdout)
  return { enabled: true, url: parsed.url, created: true }
}

export const runValidationCommands = async (
  commands: string[],
  git: GitContext | null,
  worktree: string,
  log: (message: string) => Promise<void>,
): Promise<CommandResult[]> => {
  const results: CommandResult[] = []
  for (const command of commands) {
    await log(`validation: ${command}`)
    const result = await runShell(command, {
      cwd: worktree,
      env: git?.env,
      allowFailure: true,
      onOutput: async (chunk) => {
        if (chunk.trim()) await log(chunk.trimEnd())
      },
    })
    results.push(result)
    if (result.exitCode !== 0) {
      await log(`validation failed (${result.exitCode}): ${command}`)
      break
    }
  }
  return results
}

export const parseCiChecks = (raw: string): CiCheck[] => {
  if (!raw.trim()) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('gh pr checks JSON output was not an array')
  return parsed.map((entry) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    return {
      name: String(record.name ?? 'unknown'),
      workflow: record.workflow ? String(record.workflow) : undefined,
      state: record.state ? String(record.state) : undefined,
      bucket: record.bucket ? String(record.bucket) : undefined,
      link: record.link ? String(record.link) : undefined,
    }
  })
}

export const parseCiChecksResult = (result: CommandResult): CiCheck[] => {
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout || 'no output').trim()
    throw new Error(`gh pr checks failed (${result.exitCode}): ${output}`)
  }
  return parseCiChecks(result.stdout)
}

export const isNoChecksReportedResult = (result: CommandResult) => {
  if (result.exitCode === 0) return false
  return /no checks reported/i.test(`${result.stderr}\n${result.stdout}`)
}

export const isNoRequiredChecksResult = isNoChecksReportedResult

export const summarizeChecks = (checks: CiCheck[]) => {
  const failed = checks.filter((check) => ['fail', 'cancel'].includes(check.bucket ?? ''))
  const pending = checks.filter((check) => check.bucket === 'pending')
  const passed = checks.filter((check) => ['pass', 'skipping'].includes(check.bucket ?? ''))
  return {
    failed,
    pending,
    passed,
    summary: `${passed.length} passed/skipped, ${pending.length} pending, ${failed.length} failed/cancelled`,
  }
}

export const waitForPullRequestChecks = async (
  git: GitContext,
  options: {
    timeoutSeconds: number
    intervalSeconds: number
    requiredOnly: boolean
  },
  log: (message: string) => Promise<void>,
): Promise<CiWaitResult> => {
  const started = Date.now()
  const deadline = started + options.timeoutSeconds * 1000
  let attempts = 0
  let lastChecks: CiCheck[] = []
  let lastSummary = 'checks not started'
  let effectiveRequiredOnly = options.requiredOnly

  while (Date.now() <= deadline) {
    attempts += 1
    const readChecks = async (requiredOnly: boolean) => {
      const args = [
        'pr',
        'checks',
        git.headBranch,
        '--repo',
        git.repository,
        '--json',
        'name,workflow,state,bucket,link',
      ]
      if (requiredOnly) args.push('--required')
      return await runCommand('gh', args, {
        cwd: git.worktree,
        env: git.env,
        allowFailure: true,
      })
    }

    try {
      let result = await readChecks(effectiveRequiredOnly)
      if (effectiveRequiredOnly && isNoChecksReportedResult(result)) {
        await log('ci checks: no required checks reported; falling back to all pull request checks')
        effectiveRequiredOnly = false
        result = await readChecks(false)
      }
      lastChecks = isNoChecksReportedResult(result) ? [] : parseCiChecksResult(result)
    } catch (error) {
      return {
        ok: false,
        status: 'unavailable',
        requiredOnly: effectiveRequiredOnly,
        attempts,
        durationMs: Date.now() - started,
        checks: [],
        summary: error instanceof Error ? error.message : String(error),
      }
    }

    const summary = summarizeChecks(lastChecks)
    lastSummary = summary.summary
    await log(`ci checks: ${lastSummary}`)

    if (lastChecks.length === 0) {
      lastSummary = 'no pull request checks reported yet'
      await sleep(options.intervalSeconds * 1000)
      continue
    }
    if (summary.failed.length > 0) {
      return {
        ok: false,
        status: 'failed',
        requiredOnly: effectiveRequiredOnly,
        attempts,
        durationMs: Date.now() - started,
        checks: lastChecks,
        summary: lastSummary,
      }
    }
    if (summary.pending.length === 0) {
      return {
        ok: true,
        status: 'passed',
        requiredOnly: effectiveRequiredOnly,
        attempts,
        durationMs: Date.now() - started,
        checks: lastChecks,
        summary: lastSummary,
      }
    }

    await sleep(options.intervalSeconds * 1000)
  }

  return {
    ok: false,
    status: 'timed-out',
    requiredOnly: effectiveRequiredOnly,
    attempts,
    durationMs: Date.now() - started,
    checks: lastChecks,
    summary: lastSummary,
  }
}
