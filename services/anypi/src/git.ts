import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { runCommand, runShell } from './command'
import type { AnypiConfig } from './config'
import type { AgentRunSpecPayload, CommandResult, PullRequestResult } from './types'

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

const envFlag = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

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
  const view = await runCommand(
    'gh',
    ['pr', 'view', git.headBranch, '--repo', git.repository, '--json', 'url', '--jq', '.url'],
    {
      cwd: git.worktree,
      env: git.env,
      allowFailure: true,
    },
  )
  if (view.exitCode === 0 && view.stdout.trim()) {
    await runCommand(
      'gh',
      ['pr', 'edit', git.headBranch, '--repo', git.repository, '--title', input.title, '--body', input.body],
      {
        cwd: git.worktree,
        env: git.env,
      },
    )
    return { enabled: true, url: view.stdout.trim(), created: false }
  }
  const created = await runCommand(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      git.repository,
      '--base',
      git.baseBranch,
      '--head',
      git.headBranch,
      '--title',
      input.title,
      '--body',
      input.body,
    ],
    { cwd: git.worktree, env: git.env },
  )
  const url = created.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('http'))
  return { enabled: true, url, created: true }
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
      throw new Error(`validation failed (${result.exitCode}): ${command}`)
    }
  }
  return results
}
