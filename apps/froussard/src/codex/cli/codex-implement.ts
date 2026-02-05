#!/usr/bin/env bun
import { spawn as spawnChild } from 'node:child_process'
import { copyFile, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { runCli } from './lib/cli'
import { pushCodexEventsToLoki, type RunCodexSessionResult, runCodexSession } from './lib/codex-runner'
import {
  buildDiscordChannelCommand,
  copyAgentLogIfNeeded,
  pathExists,
  randomRunId,
  timestampUtc,
} from './lib/codex-utils'
import { ensureFileDirectory } from './lib/fs'
import { type CodexLogger, consoleLogger, createCodexLogger } from './lib/logger'

interface ImplementationEventPayload {
  prompt?: string
  repository?: string
  issueNumber?: number | string
  issueTitle?: string | null
  issueBody?: string | null
  issueUrl?: string | null
  stage?: string | null
  base?: string | null
  head?: string | null
  planCommentId?: number | string | null
  planCommentUrl?: string | null
  planCommentBody?: string | null
  iteration?: number | string | null
  iterationCycle?: number | string | null
  iteration_cycle?: number | string | null
  iterations?: number | string | null
}

const readEventPayload = async (path: string): Promise<ImplementationEventPayload> => {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as ImplementationEventPayload
  } catch (error) {
    throw new Error(
      `Failed to parse event payload at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const sanitizeNullableString = (value: string | null | undefined) => {
  if (!value || value === 'null') {
    return ''
  }
  return value
}

const safeParseJson = (value: string | null | undefined) => {
  if (!value) return null
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const VALID_STAGES = new Set(['implementation', 'verify', 'review', 'planning', 'research'])

const normalizeStage = (value: string | null | undefined) => {
  if (!value) return 'implementation'
  const trimmed = value.trim().toLowerCase()
  return VALID_STAGES.has(trimmed) ? trimmed : 'implementation'
}

type CodexNotifyLogExcerpt = {
  output?: string | null
  events?: string | null
  agent?: string | null
  runtime?: string | null
  status?: string | null
}

type CodexNotifyPayload = {
  type: 'agent-turn-complete'
  repository: string
  issue_number: string
  issueNumber?: string
  base_branch: string
  head_branch: string
  workflow_name: string | null
  workflow_namespace: string | null
  workflowName?: string | null
  workflowNamespace?: string | null
  commit_sha?: string | null
  commitSha?: string | null
  head_sha?: string | null
  headSha?: string | null
  pr_number?: number | null
  pr_url?: string | null
  prNumber?: number | null
  prUrl?: string | null
  session_id: string | null
  branch?: string | null
  prompt: string
  stage?: string | null
  context_soak?: {
    fetched: number
    filtered: number
    messages: Array<Record<string, unknown>>
  } | null
  memory_soak?: {
    fetched: number
    query: string
    namespace: string
    memories: Array<Record<string, unknown>>
  } | null
  iteration?: number | null
  iteration_cycle?: number | null
  iterations?: number | null
  input_messages: string[]
  last_assistant_message: string | null
  logs?: CodexNotifyLogExcerpt
  output_paths: Record<string, string>
  log_excerpt?: CodexNotifyLogExcerpt
  issued_at: string
}

const MAX_NOTIFY_LOG_CHARS = 12_000

type NatsContextPayload = {
  fetched: number
  filtered: number
  messages: Array<Record<string, unknown>>
}

type MemoryRecord = {
  id?: string
  content?: string | null
  summary?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
  createdAt?: string | null
}

type MemoryContextPayload = {
  fetched: number
  query: string
  namespace: string
  memories: MemoryRecord[]
}

const truncateLogContent = (content: string) => {
  if (content.length <= MAX_NOTIFY_LOG_CHARS) {
    return content
  }
  const truncatedCount = content.length - MAX_NOTIFY_LOG_CHARS
  return `...[truncated ${truncatedCount} chars]\n${content.slice(-MAX_NOTIFY_LOG_CHARS)}`
}

const readLogExcerpt = async (path: string, logger?: CodexLogger) => {
  try {
    if (!(await pathExists(path))) {
      return null
    }
    const content = await readFile(path, 'utf8')
    if (!content) {
      return ''
    }
    return truncateLogContent(content)
  } catch (error) {
    logger?.warn(`Failed to read log excerpt from ${path}`, error)
    return null
  }
}

const collectLogExcerpts = async (
  {
    outputPath,
    jsonOutputPath,
    agentOutputPath,
    runtimeLogPath,
    statusPath,
  }: {
    outputPath: string
    jsonOutputPath: string
    agentOutputPath: string
    runtimeLogPath: string
    statusPath: string
  },
  logger?: CodexLogger,
): Promise<CodexNotifyLogExcerpt> => {
  const [output, events, agent, runtime, status] = await Promise.all([
    readLogExcerpt(outputPath, logger),
    readLogExcerpt(jsonOutputPath, logger),
    readLogExcerpt(agentOutputPath, logger),
    readLogExcerpt(runtimeLogPath, logger),
    readLogExcerpt(statusPath, logger),
  ])
  return {
    output,
    events,
    agent,
    runtime,
    status,
  }
}

const resolveHeadSha = async (worktree: string, logger: CodexLogger) => {
  try {
    const result = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    if (result.exitCode === 0) {
      return result.stdout.trim() || null
    }
    logger.warn(`git rev-parse HEAD failed: ${result.stderr.trim() || result.stdout.trim()}`)
  } catch (error) {
    logger.warn('git rev-parse HEAD threw', error)
  }
  return null
}

const initializeOutputFiles = async (paths: string[], logger: CodexLogger) => {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await ensureFileDirectory(path)
        await writeFile(path, '', { flag: 'a' })
      } catch (error) {
        logger.warn(`Failed to initialize output file at ${path}`, error)
      }
    }),
  )
}

const buildNotifyPayload = ({
  repository,
  issueNumber,
  baseBranch,
  headBranch,
  prompt,
  stage,
  outputPath,
  jsonOutputPath,
  agentOutputPath,
  runtimeLogPath,
  statusPath,
  patchPath,
  archivePath,
  notifyPath,
  manifestPath,
  headShaPath,
  commitShaPath,
  prNumberPath,
  prUrlPath,
  sessionId,
  lastAssistantMessage,
  logExcerpt,
  commitSha,
  headSha,
  prNumber,
  prUrl,
  contextSoak,
  memorySoak,
  iteration,
  iterationCycle,
  iterations,
}: {
  repository: string
  issueNumber: string
  baseBranch: string
  headBranch: string
  prompt: string
  stage: string
  outputPath: string
  jsonOutputPath: string
  agentOutputPath: string
  runtimeLogPath: string
  statusPath: string
  patchPath: string
  archivePath: string
  notifyPath: string
  manifestPath: string
  headShaPath: string
  commitShaPath: string
  prNumberPath: string
  prUrlPath: string
  sessionId?: string
  lastAssistantMessage?: string | null
  logExcerpt?: CodexNotifyLogExcerpt
  commitSha?: string | null
  headSha?: string | null
  prNumber?: number | null
  prUrl?: string | null
  contextSoak?: NatsContextPayload | null
  memorySoak?: MemoryContextPayload | null
  iteration?: number | null
  iterationCycle?: number | null
  iterations?: number | null
}): CodexNotifyPayload => {
  return {
    type: 'agent-turn-complete',
    repository,
    issue_number: issueNumber,
    issueNumber,
    base_branch: baseBranch,
    head_branch: headBranch,
    workflow_name: process.env.ARGO_WORKFLOW_NAME ?? null,
    workflow_namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? null,
    workflowName: process.env.ARGO_WORKFLOW_NAME ?? null,
    workflowNamespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? null,
    commit_sha: commitSha ?? null,
    commitSha: commitSha ?? null,
    head_sha: headSha ?? commitSha ?? null,
    headSha: headSha ?? commitSha ?? null,
    pr_number: prNumber ?? null,
    pr_url: prUrl ?? null,
    prNumber: prNumber ?? null,
    prUrl: prUrl ?? null,
    session_id: sessionId ?? null,
    branch: headBranch || null,
    prompt,
    stage,
    context_soak: contextSoak ?? null,
    memory_soak: memorySoak ?? null,
    iteration: iteration ?? null,
    iteration_cycle: iterationCycle ?? null,
    iterations: iterations ?? null,
    input_messages: [prompt],
    last_assistant_message: lastAssistantMessage ?? null,
    logs: logExcerpt,
    output_paths: {
      output: outputPath,
      events: jsonOutputPath,
      agent: agentOutputPath,
      runtime: runtimeLogPath,
      status: statusPath,
      patch: patchPath,
      changes: archivePath,
      notify: notifyPath,
      changes_manifest: manifestPath,
      head_sha: headShaPath,
      commit_sha: commitShaPath,
      pr_number: prNumberPath,
      pr_url: prUrlPath,
    },
    log_excerpt: logExcerpt,
    issued_at: new Date().toISOString(),
  }
}

const sleep = async (durationMs: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs)
  })

const postNotifyPayload = async (payload: CodexNotifyPayload, logger: CodexLogger) => {
  const baseUrl = sanitizeNullableString(process.env.CODEX_NOTIFY_URL ?? process.env.JANGAR_BASE_URL ?? '')
  if (!baseUrl) {
    logger.warn('Notify disabled: missing CODEX_NOTIFY_URL or JANGAR_BASE_URL')
    return
  }

  const notifyUrl = baseUrl.endsWith('/api/codex/notify') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/codex/notify`
  const maxAttempts = 4
  const baseDelayMs = 1000
  const maxDelayMs = 10000
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(notifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.ok) {
        if (attempt > 1) {
          logger.info(`Notify delivered after ${attempt} attempts`)
        }
        return
      }

      const body = await response.text()
      const bodySuffix = body ? `: ${body}` : ''
      lastError = new Error(`Notify failed (${response.status})${bodySuffix}`)
      logger.warn(`Notify failed (attempt ${attempt}/${maxAttempts}, status ${response.status})${bodySuffix}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Notify request failed')
      logger.warn(`Notify request failed (attempt ${attempt}/${maxAttempts})`, error)
    }

    if (attempt < maxAttempts) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      logger.debug(`Retrying notify in ${delayMs}ms`, { attempt, maxAttempts })
      await sleep(delayMs)
    }
  }

  if (lastError) {
    logger.warn('Notify failed after retries', lastError)
  }
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export const ensurePullRequestExists = async (repository: string, headBranch: string, logger: CodexLogger) => {
  if (process.env.CODEX_SKIP_PR_CHECK === '1') {
    logger.debug('Skipping pull request verification (CODEX_SKIP_PR_CHECK=1)')
    return
  }

  if (!repository || !headBranch) {
    throw new Error('Repository and head branch are required to verify pull request state')
  }

  const owner = repository.includes('/') ? (repository.split('/')[0] ?? '') : ''
  const headSelector = headBranch.includes(':') || !owner ? headBranch : `${owner}:${headBranch}`

  const maxAttempts = Math.max(1, Number.parseInt(process.env.CODEX_PR_CHECK_ATTEMPTS ?? '8', 10))
  const retryDelayMs = Math.max(0, Number.parseInt(process.env.CODEX_PR_CHECK_RETRY_MS ?? '5000', 10))

  const selectors = Array.from(new Set([headSelector, headBranch].filter((value) => Boolean(value)) as string[]))

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const selector of selectors) {
      logger.debug('Verifying pull request existence', { repository, head: selector, attempt })
      const prResult = await runCommand('gh', [
        'pr',
        'list',
        '--repo',
        repository,
        '--state',
        'all',
        '--head',
        selector,
        '--json',
        'number,url,state',
        '--limit',
        '1',
      ])

      if (prResult.exitCode === 0) {
        try {
          const parsed = JSON.parse(prResult.stdout || '[]')
          if (Array.isArray(parsed) && parsed.length > 0) {
            logger.debug('Found pull request for branch', { repository, head: selector, attempt })
            return
          }
          lastError = new Error(`No pull request found for branch '${selector}' in ${repository}`)
        } catch (error) {
          lastError = new Error(
            `Failed to parse gh pr list output: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } else {
        const message = prResult.stderr.trim() || prResult.stdout.trim()
        lastError = new Error(`Failed to verify pull request for ${repository}#${selector}: ${message}`)
      }
    }

    if (attempt < maxAttempts) {
      logger.info('Retrying pull request verification', {
        repository,
        headBranch,
        attempt,
        maxAttempts,
        retryDelayMs,
      })
      await sleep(retryDelayMs)
    }
  }

  if (lastError) {
    throw lastError
  }

  throw new Error(`No pull request found for branch '${headBranch}' in ${repository}`)
}

type PullRequestInfo = {
  number: number
  url: string
  title?: string | null
  body?: string | null
  headSha?: string | null
  headRef?: string | null
  baseRef?: string | null
}

const extractSectionLines = (text: string, header: string) => {
  const lines = text.replace(/\r/g, '').split('\n')
  const headerIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith(header.toLowerCase()))
  if (headerIndex < 0) return []
  const collected: string[] = []
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line) {
      if (collected.length > 0) break
      continue
    }
    if (/^[A-Za-z].*:/.test(line)) break
    collected.push(line)
  }
  return collected
}

const extractSummary = (message?: string | null) => {
  if (!message) return null
  const summaryLines = extractSectionLines(message, 'Summary')
  if (summaryLines.length > 0) {
    return summaryLines.map((line) => line.replace(/^[-*]\s*/, '')).join(' ')
  }
  const firstLine = message
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ?? null
}

const extractTests = (message?: string | null) => {
  if (!message) return []
  const testLines = extractSectionLines(message, 'Tests')
  return testLines.map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean)
}

const extractKnownGaps = (message?: string | null) => {
  if (!message) return []
  const gapLines = extractSectionLines(message, 'Known gaps')
  if (gapLines.length > 0) return gapLines.map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean)
  const altLines = extractSectionLines(message, 'Gaps')
  return altLines.map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean)
}

const listPullRequestByHead = async (repository: string, headBranch: string) => {
  const owner = repository.includes('/') ? (repository.split('/')[0] ?? '') : ''
  const headSelector = headBranch.includes(':') || !owner ? headBranch : `${owner}:${headBranch}`
  const selectors = Array.from(new Set([headSelector, headBranch].filter(Boolean)))
  let lastError: Error | undefined

  for (const selector of selectors) {
    const result = await runCommand('gh', [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'all',
      '--head',
      selector,
      '--json',
      'number,url,title,body,headRefOid,headRefName,baseRefName',
      '--limit',
      '1',
    ])
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim()
      lastError = new Error(`Failed to list PR for ${repository}#${selector}: ${message}`)
      continue
    }
    const parsed = JSON.parse(result.stdout || '[]') as Array<
      PullRequestInfo & { headRefOid?: string | null; headRefName?: string | null; baseRefName?: string | null }
    >
    if (parsed.length === 0) {
      lastError = new Error(`No pull request found for branch '${selector}' in ${repository}`)
      continue
    }
    const entry = parsed[0]
    return {
      number: entry.number,
      url: entry.url,
      title: entry.title ?? null,
      body: entry.body ?? null,
      headSha: entry.headSha ?? entry.headRefOid ?? null,
      headRef: entry.headRef ?? entry.headRefName ?? null,
      baseRef: entry.baseRef ?? entry.baseRefName ?? null,
    }
  }

  if (lastError) {
    throw lastError
  }
  return null
}

const updatePullRequest = async (repository: string, pr: PullRequestInfo, title: string, body: string) => {
  const args = ['pr', 'edit', String(pr.number), '--repo', repository, '--title', title, '--body', body]
  const result = await runCommand('gh', args)
  if (result.exitCode === 0) {
    return
  }
  const message = result.stderr.trim() || result.stdout.trim()
  const payload = JSON.stringify({ title, body })
  const tmpDir = await mkdtemp(join(tmpdir(), 'codex-pr-update-'))
  const payloadPath = join(tmpDir, 'payload.json')
  await writeFile(payloadPath, payload, 'utf8')
  const apiResult = await runCommand('gh', [
    'api',
    `repos/${repository}/pulls/${pr.number}`,
    '--method',
    'PATCH',
    '--input',
    payloadPath,
  ])
  if (apiResult.exitCode !== 0) {
    const apiMessage = apiResult.stderr.trim() || apiResult.stdout.trim()
    throw new Error(`Failed to update PR ${pr.number}: ${message || apiMessage}`)
  }
}

const createPullRequest = async (
  repository: string,
  headBranch: string,
  baseBranch: string,
  title: string,
  body: string,
) => {
  const args = [
    'pr',
    'create',
    '--repo',
    repository,
    '--head',
    headBranch,
    '--base',
    baseBranch,
    '--title',
    title,
    '--body',
    body,
  ]
  const result = await runCommand('gh', args)
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim()
    const existing = await listPullRequestByHead(repository, headBranch).catch(() => null)
    if (existing) {
      return existing
    }
    throw new Error(`Failed to create PR for ${headBranch}: ${message}`)
  }
  return listPullRequestByHead(repository, headBranch)
}

const ensurePullRequest = async (input: {
  repository: string
  headBranch: string
  baseBranch: string
  issueNumber: string
  issueTitle?: string | null
  lastAssistantMessage?: string | null
  logger: CodexLogger
}) => {
  if (process.env.CODEX_SKIP_PR_CHECK === '1') {
    input.logger.debug('Skipping pull request create/update (CODEX_SKIP_PR_CHECK=1)')
    return null
  }
  const title = input.issueTitle?.trim() || `Codex: Issue #${input.issueNumber}`
  const body = input.lastAssistantMessage?.trim() || `Implementation for #${input.issueNumber}.`

  const existing = await listPullRequestByHead(input.repository, input.headBranch)
  if (existing) {
    await updatePullRequest(input.repository, existing, title, body)
    return existing
  }

  const created = await createPullRequest(input.repository, input.headBranch, input.baseBranch, title, body)
  if (!created) {
    throw new Error(`PR creation did not return a PR for ${input.headBranch}`)
  }
  return created
}

const runCommand = async (command: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> => {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawnChild(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      })
    })
  })
}

const readGitConfigValue = async (worktree: string, key: string) => {
  try {
    const result = await runCommand('git', ['config', '--get', key], { cwd: worktree })
    if (result.exitCode !== 0) {
      return null
    }
    const value = result.stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

const ensureGitIdentity = async (worktree: string, logger: CodexLogger) => {
  const fallbackName = (process.env.CODEX_GIT_AUTHOR_NAME ?? process.env.GIT_AUTHOR_NAME ?? 'Codex').trim()
  const fallbackEmail = (
    process.env.CODEX_GIT_AUTHOR_EMAIL ??
    process.env.GIT_AUTHOR_EMAIL ??
    'codex@proompteng.ai'
  ).trim()

  const name = fallbackName.length > 0 ? fallbackName : 'Codex'
  const email = fallbackEmail.length > 0 ? fallbackEmail : 'codex@proompteng.ai'

  const existingName = await readGitConfigValue(worktree, 'user.name')
  if (!existingName) {
    const result = await runCommand('git', ['config', 'user.name', name], { cwd: worktree })
    if (result.exitCode !== 0) {
      logger.warn(`Failed to set git user.name (${result.exitCode})`, result.stderr.trim())
    }
  }

  const existingEmail = await readGitConfigValue(worktree, 'user.email')
  if (!existingEmail) {
    const result = await runCommand('git', ['config', 'user.email', email], { cwd: worktree })
    if (result.exitCode !== 0) {
      logger.warn(`Failed to set git user.email (${result.exitCode})`, result.stderr.trim())
    }
  }
}

const resolveBaseRef = async (worktree: string, baseBranch: string, logger: CodexLogger) => {
  const candidates = [baseBranch ? `origin/${baseBranch}` : '', baseBranch, 'HEAD^'].filter(
    (value) => value && value.trim().length > 0,
  )
  for (const candidate of candidates) {
    const result = await runCommand('git', ['rev-parse', '--verify', candidate], { cwd: worktree })
    if (result.exitCode === 0) {
      return candidate
    }
  }
  logger.warn('Failed to resolve base ref for implementation artifacts', { baseBranch, candidates })
  return null
}

const commitWorkingTreeIfNeeded = async ({
  worktree,
  issueNumber,
  issueTitle,
  logger,
}: {
  worktree: string
  issueNumber: string
  issueTitle?: string | null
  logger: CodexLogger
}) => {
  const isCodexArtifactPath = (value: string) => value.startsWith('.codex')
  const collectPaths = (raw: string) =>
    raw
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !isCodexArtifactPath(entry))

  const trackedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB'], { cwd: worktree })
  if (trackedResult.exitCode !== 0) {
    logger.warn('git diff --name-only failed; skipping auto-commit', trackedResult.stderr.trim())
    return false
  }
  const deletedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=D'], { cwd: worktree })
  if (deletedResult.exitCode !== 0) {
    logger.warn('git diff --name-only for deletions failed; skipping auto-commit', deletedResult.stderr.trim())
    return false
  }
  const untrackedResult = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd: worktree })
  if (untrackedResult.exitCode !== 0) {
    logger.warn('git ls-files failed; skipping auto-commit', untrackedResult.stderr.trim())
    return false
  }

  const paths = new Set([
    ...collectPaths(trackedResult.stdout),
    ...collectPaths(deletedResult.stdout),
    ...collectPaths(untrackedResult.stdout),
  ])
  if (paths.size === 0) {
    return false
  }

  await ensureGitIdentity(worktree, logger)

  const addResult = await runCommand('git', ['add', '-A', '--', ...paths], { cwd: worktree })
  if (addResult.exitCode !== 0) {
    const message = addResult.stderr.trim() || addResult.stdout.trim()
    throw new Error(`git add failed (${addResult.exitCode}): ${message}`)
  }

  const defaultMessage = issueTitle?.trim()
    ? `chore(codex): ${issueTitle.trim()}`
    : `chore(codex): issue #${issueNumber}`
  const commitMessage = (process.env.CODEX_COMMIT_MESSAGE ?? defaultMessage).trim() || defaultMessage

  const commitResult = await runCommand('git', ['commit', '-m', commitMessage], { cwd: worktree })
  if (commitResult.exitCode !== 0) {
    const message = commitResult.stderr.trim() || commitResult.stdout.trim()
    throw new Error(`git commit failed (${commitResult.exitCode}): ${message}`)
  }

  logger.info('Committed implementation changes', { message: commitMessage })
  return true
}

const pushHeadBranch = async ({
  worktree,
  headBranch,
  logger,
}: {
  worktree: string
  headBranch: string
  logger: CodexLogger
}) => {
  if (!headBranch) {
    throw new Error('Head branch is required to push implementation changes')
  }
  const pushRef = `HEAD:${headBranch}`
  const result = await runCommand('git', ['push', '-u', 'origin', pushRef], { cwd: worktree })
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim()
    throw new Error(`git push failed (${result.exitCode}): ${message}`)
  }
  logger.info('Pushed implementation branch', { headBranch })
}

const truncateContextLine = (value: string, max = 400) => {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

const formatMemoryContextBlock = (payload: MemoryContextPayload | null, maxMemories = 6) => {
  if (!payload || payload.memories.length === 0) return ''
  const memories = payload.memories.slice(0, maxMemories)
  const lines = memories.map((memory) => {
    const summary =
      typeof memory.summary === 'string' && memory.summary.trim().length > 0 ? memory.summary.trim() : 'memory'
    const created =
      typeof memory.createdAt === 'string' && memory.createdAt.trim().length > 0 ? memory.createdAt : 'unknown-time'
    const content =
      typeof memory.content === 'string' && memory.content.trim().length > 0
        ? truncateContextLine(memory.content.trim(), 600)
        : ''
    return `- [${created}] ${summary}${content ? ` :: ${content}` : ''}`
  })
  return `Jangar memory snapshots (namespace=${payload.namespace}, query="${payload.query}"):\n${lines.join('\n')}`
}

const formatNatsContextBlock = (payload: NatsContextPayload | null, maxMessages = 25) => {
  if (!payload || payload.messages.length === 0) return ''
  const messages = payload.messages.slice(-maxMessages)
  const lines = messages.map((message) => {
    const timestamp =
      typeof message.timestamp === 'string'
        ? message.timestamp
        : typeof message.sent_at === 'string'
          ? message.sent_at
          : 'unknown-time'
    const kind = typeof message.kind === 'string' ? message.kind : 'message'
    const content =
      typeof message.content === 'string' && message.content.trim().length > 0
        ? message.content.trim()
        : message.attrs
          ? JSON.stringify(message.attrs)
          : JSON.stringify(message)
    return `- [${timestamp}] (${kind}) ${truncateContextLine(content, 500)}`
  })
  return `Context soak from NATS general channel (latest ${messages.length} of ${payload.filtered}):\n${lines.join('\n')}`
}

const fetchNatsContext = async ({
  logger,
  required,
  outputPath,
}: {
  logger: CodexLogger
  required: boolean
  outputPath: string
}): Promise<NatsContextPayload | null> => {
  if (!process.env.NATS_URL) {
    if (required) {
      throw new Error('NATS_URL is required for context soak')
    }
    return null
  }

  try {
    const result = await runCommand('codex-nats-soak', [], { cwd: process.env.WORKTREE })
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || 'codex-nats-soak failed'
      if (required) {
        throw new Error(message)
      }
      logger.warn(`NATS context soak failed: ${message}`)
      return null
    }

    const raw = await readFile(outputPath, 'utf8')
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw) as NatsContextPayload
    return parsed
  } catch (error) {
    if (required) {
      throw error
    }
    logger.warn('NATS context soak failed', error)
    return null
  }
}

const fetchJangarMemories = async ({
  logger,
  required,
  namespace,
  query,
  limit,
}: {
  logger: CodexLogger
  required: boolean
  namespace: string
  query: string
  limit: number
}): Promise<MemoryContextPayload | null> => {
  const baseUrl = sanitizeNullableString(process.env.JANGAR_BASE_URL ?? '')
  if (!baseUrl) {
    if (required) {
      throw new Error('JANGAR_BASE_URL is required for memory soak')
    }
    return null
  }

  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/memories`)
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('query', query)
  url.searchParams.set('limit', String(limit))

  const maxAttempts = 3
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url.toString())
      if (!response.ok) {
        const message = await response.text()
        throw new Error(`Memory fetch failed (${response.status}): ${message}`)
      }
      const payload = (await response.json()) as { memories?: MemoryRecord[] }
      const memories = Array.isArray(payload.memories) ? payload.memories : []
      return {
        fetched: memories.length,
        query,
        namespace,
        memories,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Memory fetch failed')
      logger.warn(`Jangar memory fetch failed (attempt ${attempt}/${maxAttempts})`, lastError)
      if (attempt < maxAttempts) {
        await sleep(750 * attempt)
      }
    }
  }

  if (required && lastError) {
    throw lastError
  }
  return null
}

const publishNatsEvent = async (
  logger: CodexLogger,
  input: { kind: string; content: string; attrs?: Record<string, unknown> },
) => {
  if (!process.env.NATS_URL) return
  const args = ['--kind', input.kind, '--content', input.content, '--channel', 'general', '--publish-general']
  if (input.attrs && Object.keys(input.attrs).length > 0) {
    args.push('--attrs-json', JSON.stringify(input.attrs))
  }
  try {
    await runCommand('codex-nats-publish', args)
  } catch (error) {
    logger.warn('Failed to publish NATS event', error)
  }
}

interface CaptureImplementationArtifactsOptions {
  worktree: string
  archivePath: string
  patchPath: string
  statusPath: string
  manifestPath: string
  jsonEventsPath?: string
  resumeMetadataPath: string
  baseRef?: string | null
  repository: string
  issueNumber: string
  prompt: string
  sessionId?: string
  resumedSessionId?: string
  markForResume: boolean
  logger: CodexLogger
}

interface ImplementationManifest {
  version: number
  generatedAt: string
  worktree: string
  repository: string
  issueNumber: string
  issue_number?: string
  prompt: string
  commitSha: string | null
  commit_sha?: string | null
  sessionId?: string
  session_id?: string
  trackedFiles: string[]
  deletedFiles: string[]
}

interface ResumeMetadataFile extends ImplementationManifest {
  resumedFromSessionId?: string
  archivePath: string
  patchPath: string
  statusPath: string
  state: 'pending' | 'cleared'
}

interface ResumeContext {
  path: string
  metadata: ResumeMetadataFile
}

const RESUME_METADATA_RELATIVE_PATH = ['.codex', 'implementation-resume.json']

const getResumeMetadataPath = (worktree: string) => join(worktree, ...RESUME_METADATA_RELATIVE_PATH)

const isSafeRelativePath = (filePath: string) => {
  return !!filePath && !filePath.startsWith('/') && !filePath.includes('..')
}

const isNotFoundError = (error: unknown): error is NodeJS.ErrnoException =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code?: string }).code === 'ENOENT',
  )

const extractSessionIdFromParsedEvent = (parsed: Record<string, unknown>): string | undefined => {
  const candidates = [
    parsed?.session instanceof Object ? (parsed.session as Record<string, unknown>).id : parsed?.session,
    parsed?.session_id,
    parsed?.sessionId,
    parsed?.conversation_id,
    parsed?.conversationId,
    parsed?.item instanceof Object && 'session' in (parsed.item as object)
      ? ((parsed.item as Record<string, unknown>).session as Record<string, unknown> | undefined)?.id
      : undefined,
    parsed?.item instanceof Object ? (parsed.item as Record<string, unknown>).session_id : undefined,
    parsed?.item instanceof Object ? (parsed.item as Record<string, unknown>).sessionId : undefined,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return undefined
}

const extractSessionIdFromEvents = async (eventsPath: string | undefined, logger: CodexLogger) => {
  if (!eventsPath) {
    return undefined
  }

  try {
    const raw = await readFile(eventsPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const sessionId = extractSessionIdFromParsedEvent(parsed)
        if (sessionId) {
          return sessionId
        }
      } catch (error) {
        logger.warn('Failed to parse Codex events while extracting session id', error)
      }
    }
  } catch (error) {
    logger.warn(`Unable to read Codex events at ${eventsPath} while extracting session id`, error)
  }

  return undefined
}

const normalizeIssueNumber = (value: string | number) => String(value)

const parseOptionalInt = (value: string | number | null | undefined) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const readResumeContext = async (path: string, logger: CodexLogger): Promise<ResumeContext | undefined> => {
  if (!(await pathExists(path))) {
    return undefined
  }
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as ResumeMetadataFile
    if (typeof parsed.version !== 'number' || parsed.version < 1) {
      logger.warn(`Unsupported implementation resume metadata version in ${path}`)
      return undefined
    }
    return { metadata: parsed, path }
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined
    }
    logger.warn(`Failed to parse implementation resume metadata at ${path}`, error)
    return undefined
  }
}

const loadResumeMetadata = async ({
  worktree,
  repository,
  issueNumber,
  logger,
}: {
  worktree: string
  repository: string
  issueNumber: string
  logger: CodexLogger
}): Promise<ResumeContext | undefined> => {
  const metadataPath = getResumeMetadataPath(worktree)
  const context = await readResumeContext(metadataPath, logger)
  if (!context) {
    return undefined
  }

  const normalizedIssue = normalizeIssueNumber(issueNumber)
  if (context.metadata.state !== 'pending') {
    return undefined
  }

  if (context.metadata.repository !== repository || context.metadata.issueNumber !== normalizedIssue) {
    logger.info(
      `Ignoring resume state for ${context.metadata.repository}#${context.metadata.issueNumber}; requested ${repository}#${normalizedIssue}`,
    )
    return undefined
  }

  return context
}

const ensureEmptyFile = async (path: string) => {
  if (await pathExists(path)) {
    return
  }
  await ensureFileDirectory(path)
  await writeFile(path, '', 'utf8')
}

const ensureNotifyPlaceholder = async (path: string, logger: CodexLogger) => {
  try {
    await ensureFileDirectory(path)
    await writeFile(path, '', { flag: 'a' })
  } catch (error) {
    logger.warn(`Failed to ensure notify placeholder at ${path}`, error)
  }
}
const extractArchiveTo = async (archivePath: string, destination: string) => {
  await new Promise<void>((resolve, reject) => {
    const tarProcess = spawnChild('tar', ['-xzf', archivePath, '-C', destination], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    tarProcess.on('error', (error) => reject(error))
    tarProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar exited with status ${code}`))
      }
    })
  })
}

const applyResumeContext = async ({
  worktree,
  context,
  logger,
}: {
  worktree: string
  context: ResumeContext
  logger: CodexLogger
}) => {
  const archivePath = context.metadata.archivePath
  if (!archivePath || !(await pathExists(archivePath))) {
    logger.warn(`Implementation resume archive not found at ${archivePath}`)
    return false
  }

  let extractionRoot: string | undefined
  try {
    extractionRoot = await mkdtemp(join(tmpdir(), 'codex-impl-resume-'))
    await extractArchiveTo(archivePath, extractionRoot)

    const manifestPath = join(extractionRoot, 'metadata', 'manifest.json')
    let manifest: ImplementationManifest | undefined
    if (await pathExists(manifestPath)) {
      try {
        const manifestRaw = await readFile(manifestPath, 'utf8')
        manifest = JSON.parse(manifestRaw) as ImplementationManifest
      } catch (error) {
        logger.warn('Failed to parse implementation resume manifest; continuing with recorded metadata', error)
      }
    }

    const trackedFiles = new Set(context.metadata.trackedFiles ?? [])
    const deletedFiles = new Set(context.metadata.deletedFiles ?? [])

    if (manifest) {
      manifest.trackedFiles.forEach((file) => {
        trackedFiles.add(file)
      })
      manifest.deletedFiles.forEach((file) => {
        deletedFiles.add(file)
      })
    }

    const filesDir = join(extractionRoot, 'files')
    let copiedCount = 0

    for (const relativePath of trackedFiles) {
      if (!isSafeRelativePath(relativePath)) {
        logger.warn(`Skipping unsafe resume path '${relativePath}'`)
        continue
      }
      const sourcePath = join(filesDir, relativePath)
      if (!(await pathExists(sourcePath))) {
        logger.warn(`Resume archive missing file '${relativePath}'`)
        continue
      }
      const destinationPath = join(worktree, relativePath)
      await ensureFileDirectory(destinationPath)
      await rm(destinationPath, { force: true, recursive: true })
      try {
        const stats = await lstat(sourcePath)
        if (stats.isSymbolicLink()) {
          const linkTarget = await readlink(sourcePath)
          await symlink(linkTarget, destinationPath)
        } else if (stats.isFile()) {
          await copyFile(sourcePath, destinationPath)
        } else {
          logger.warn(`Skipping non-file path '${relativePath}' in resume archive`)
          continue
        }
      } catch (error) {
        logger.warn(`Failed to restore '${relativePath}' from resume archive`, error)
        continue
      }
      copiedCount += 1
    }

    let removedCount = 0
    for (const relativePath of deletedFiles) {
      if (!isSafeRelativePath(relativePath)) {
        logger.warn(`Skipping unsafe delete path '${relativePath}' in resume metadata`)
        continue
      }
      const targetPath = join(worktree, relativePath)
      try {
        await rm(targetPath, { force: true, recursive: true })
        removedCount += 1
      } catch (error) {
        logger.warn(`Failed to remove '${relativePath}' while applying resume metadata`, error)
      }
    }

    logger.info(
      `Restored implementation resume state with ${copiedCount} file(s) copied and ${removedCount} file(s) removed`,
    )
    return true
  } catch (error) {
    logger.error('Failed to apply implementation resume state', error)
    return false
  } finally {
    if (extractionRoot) {
      await rm(extractionRoot, { recursive: true, force: true })
    }
  }
}

const captureImplementationArtifacts = async ({
  worktree,
  archivePath,
  patchPath,
  statusPath,
  manifestPath,
  jsonEventsPath,
  resumeMetadataPath,
  baseRef,
  repository,
  issueNumber,
  prompt,
  sessionId,
  resumedSessionId,
  markForResume,
  logger,
}: CaptureImplementationArtifactsOptions) => {
  const cleanupBundle = async (bundleRoot: string) => {
    try {
      await rm(bundleRoot, { recursive: true, force: true })
    } catch (error) {
      logger.warn('Failed to clean up implementation artifact bundle directory', error)
    }
  }

  let bundleRoot: string | undefined

  try {
    bundleRoot = await mkdtemp(join(tmpdir(), 'codex-impl-artifacts-'))
    const metadataDir = join(bundleRoot, 'metadata')
    const filesDir = join(bundleRoot, 'files')
    await ensureFileDirectory(join(metadataDir, '.keep'))

    let statusContent = ''
    try {
      const statusResult = await runCommand('git', ['status', '--short', '--branch'], { cwd: worktree })
      if (statusResult.exitCode === 0) {
        statusContent = statusResult.stdout.trim()
      } else {
        statusContent = `git status failed (exit ${statusResult.exitCode}): ${statusResult.stderr.trim()}`
        logger.warn('git status failed while capturing implementation artifacts', statusResult.stderr.trim())
      }
    } catch (error) {
      statusContent = `git status failed: ${error instanceof Error ? error.message : String(error)}`
      logger.warn('git status threw while capturing implementation artifacts', error)
    }

    await ensureFileDirectory(statusPath)
    await writeFile(statusPath, `${statusContent}\n`, 'utf8')
    await ensureFileDirectory(join(metadataDir, 'git-status.txt'))
    await writeFile(join(metadataDir, 'git-status.txt'), `${statusContent}\n`, 'utf8')

    const diffSpec = baseRef ? `${baseRef}..HEAD` : 'HEAD'
    let diffContent = ''
    try {
      const diffResult = await runCommand('git', ['diff', '--binary', diffSpec], { cwd: worktree })
      if (diffResult.exitCode === 0) {
        diffContent = diffResult.stdout
      } else {
        diffContent = `git diff failed (exit ${diffResult.exitCode}): ${diffResult.stderr.trim()}`
        logger.warn('git diff failed while capturing implementation artifacts', diffResult.stderr.trim())
      }
    } catch (error) {
      diffContent = `git diff failed: ${error instanceof Error ? error.message : String(error)}`
      logger.warn('git diff threw while capturing implementation artifacts', error)
    }

    await ensureFileDirectory(patchPath)
    await writeFile(patchPath, diffContent, 'utf8')
    await ensureFileDirectory(join(metadataDir, 'git-diff.patch'))
    await writeFile(join(metadataDir, 'git-diff.patch'), diffContent, 'utf8')

    const trackedFiles = new Set<string>()
    const deletedFiles: string[] = []

    try {
      const trackedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', diffSpec], {
        cwd: worktree,
      })
      if (trackedResult.exitCode === 0) {
        trackedResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => {
            trackedFiles.add(entry)
          })
      } else {
        logger.warn('git diff --name-only failed while capturing implementation artifacts', trackedResult.stderr.trim())
      }
    } catch (error) {
      logger.warn('git diff --name-only threw while capturing implementation artifacts', error)
    }

    try {
      const deletedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=D', diffSpec], {
        cwd: worktree,
      })
      if (deletedResult.exitCode === 0) {
        deletedResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => {
            deletedFiles.push(entry)
          })
      }
    } catch (error) {
      logger.warn('git diff --name-only for deletions threw while capturing implementation artifacts', error)
    }

    try {
      const untrackedResult = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: worktree,
      })
      if (untrackedResult.exitCode === 0) {
        untrackedResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .forEach((entry) => {
            trackedFiles.add(entry)
          })
      } else {
        logger.warn('git ls-files failed while capturing implementation artifacts', untrackedResult.stderr.trim())
      }
    } catch (error) {
      logger.warn('git ls-files threw while capturing implementation artifacts', error)
    }

    let commitSha: string | null = null
    try {
      const commitResult = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree })
      if (commitResult.exitCode === 0) {
        commitSha = commitResult.stdout.trim() || null
      } else {
        logger.warn('git rev-parse HEAD failed while capturing implementation artifacts', commitResult.stderr.trim())
      }
    } catch (error) {
      logger.warn('git rev-parse HEAD threw while capturing implementation artifacts', error)
    }

    const resolvedSessionId = sessionId ?? (await extractSessionIdFromEvents(jsonEventsPath, logger))

    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      worktree,
      repository,
      issueNumber,
      issue_number: issueNumber,
      prompt,
      commitSha,
      commit_sha: commitSha,
      sessionId: resolvedSessionId,
      session_id: resolvedSessionId,
      trackedFiles: Array.from(trackedFiles).sort(),
      deletedFiles: deletedFiles.sort(),
    } satisfies ImplementationManifest

    await ensureFileDirectory(join(metadataDir, 'manifest.json'))
    await writeFile(join(metadataDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    await ensureFileDirectory(manifestPath)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    for (const relativePath of trackedFiles) {
      const sourcePath = join(worktree, relativePath)
      const destinationPath = join(filesDir, relativePath)

      let stats: import('node:fs').Stats
      try {
        stats = await lstat(sourcePath)
      } catch {
        continue
      }

      if (!stats.isFile() && !stats.isSymbolicLink()) {
        continue
      }

      try {
        await ensureFileDirectory(destinationPath)
        await rm(destinationPath, { force: true })
        if (stats.isSymbolicLink()) {
          const linkTarget = await readlink(sourcePath)
          await symlink(linkTarget, destinationPath)
        } else {
          await copyFile(sourcePath, destinationPath)
        }
      } catch (error) {
        logger.warn(`Failed to copy changed path '${relativePath}' into artifact bundle`, error)
      }
    }

    await ensureFileDirectory(archivePath)
    const tarProcess = spawnChild('tar', ['-czf', archivePath, '-C', bundleRoot, '.'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const tarExit = await new Promise<number>((resolve, reject) => {
      tarProcess.on('error', (tarError) => {
        reject(tarError)
      })
      tarProcess.on('close', (code) => {
        resolve(code ?? -1)
      })
    })
    if (tarExit !== 0) {
      throw new Error(`tar exited with status ${tarExit}`)
    }

    const resumeMetadata: ResumeMetadataFile = {
      ...manifest,
      archivePath,
      patchPath,
      statusPath,
      state: markForResume ? 'pending' : 'cleared',
      resumedFromSessionId: resumedSessionId,
    }

    await ensureFileDirectory(resumeMetadataPath)
    await writeFile(resumeMetadataPath, JSON.stringify(resumeMetadata, null, 2), 'utf8')
  } catch (error) {
    logger.error('Failed to capture implementation change artifacts', error)
    try {
      await ensureFileDirectory(archivePath)
      await writeFile(
        archivePath,
        `Failed to capture implementation artifacts: ${error instanceof Error ? error.message : String(error)}\n`,
        'utf8',
      )
    } catch (writeError) {
      logger.error('Failed to write fallback implementation artifact payload', writeError)
    }
  } finally {
    if (bundleRoot) {
      await cleanupBundle(bundleRoot)
    }
  }
}

export const runCodexImplementation = async (eventPath: string) => {
  if (!(await pathExists(eventPath))) {
    throw new Error(`Event payload file not found at '${eventPath}'`)
  }

  const event = await readEventPayload(eventPath)

  let prompt = event.prompt?.trim() ?? ''

  const repository = event.repository?.trim()
  if (!repository) {
    throw new Error('Missing repository metadata in event payload')
  }

  const issueNumberRaw = event.issueNumber
  const issueNumber = issueNumberRaw !== undefined && issueNumberRaw !== null ? String(issueNumberRaw) : ''
  if (!issueNumber) {
    throw new Error('Missing issue number metadata in event payload')
  }

  const rawStage = event.stage ?? process.env.CODEX_STAGE ?? 'implementation'
  const stage = normalizeStage(rawStage)
  const iteration = parseOptionalInt(event.iteration)
  const iterationCycle = parseOptionalInt(event.iterationCycle ?? event.iteration_cycle)
  const iterations = parseOptionalInt(event.iterations)

  const worktree = process.env.WORKTREE ?? '/workspace/lab'
  const defaultOutputPath = `${worktree}/.codex-implementation.log`
  const outputPath = process.env.OUTPUT_PATH ?? defaultOutputPath
  const jsonOutputPath = process.env.JSON_OUTPUT_PATH ?? `${worktree}/.codex-implementation-events.jsonl`
  const agentOutputPath = process.env.AGENT_OUTPUT_PATH ?? `${worktree}/.codex-implementation-agent.log`
  const runtimeLogPath = process.env.CODEX_RUNTIME_LOG_PATH ?? `${worktree}/.codex-implementation-runtime.log`
  const patchPath = process.env.IMPLEMENTATION_PATCH_PATH ?? `${worktree}/.codex-implementation.patch`
  const statusPath = process.env.IMPLEMENTATION_STATUS_PATH ?? `${worktree}/.codex-implementation-status.txt`
  const archivePath =
    process.env.IMPLEMENTATION_CHANGES_ARCHIVE_PATH ?? `${worktree}/.codex-implementation-changes.tar.gz`
  const notifyPath = process.env.IMPLEMENTATION_NOTIFY_PATH ?? `${worktree}/.codex-implementation-notify.json`
  const manifestPath =
    process.env.IMPLEMENTATION_CHANGES_MANIFEST_PATH ?? `${worktree}/.codex-implementation-changes-manifest.json`
  const headShaPath = process.env.CODEX_HEAD_SHA_PATH ?? `${worktree}/.codex-head-sha.txt`
  const commitShaPath = process.env.COMMIT_SHA_PATH ?? `${worktree}/.codex-commit-sha.txt`
  const prNumberPath = process.env.PR_NUMBER_PATH ?? `${worktree}/.codex-pr-number.txt`
  const prUrlPath = process.env.PR_URL_PATH ?? `${worktree}/.codex-pr-url.txt`
  const natsContextPath = process.env.NATS_CONTEXT_PATH ?? `${worktree}/.codex-nats-context.json`
  const resumeMetadataPath = getResumeMetadataPath(worktree)
  const lokiEndpoint =
    process.env.LGTM_LOKI_ENDPOINT ??
    'http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push'
  const lokiTenant = process.env.LGTM_LOKI_TENANT
  const lokiBasicAuth = process.env.LGTM_LOKI_BASIC_AUTH

  const baseBranch = sanitizeNullableString(event.base) || process.env.BASE_BRANCH || 'main'
  const headBranch = sanitizeNullableString(event.head) || process.env.HEAD_BRANCH || ''

  if (!headBranch) {
    throw new Error('Missing head branch metadata in event payload')
  }

  const assertCommandSuccess = (result: CommandResult, description: string) => {
    if (result.exitCode !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
      throw new Error(`${description} failed (exit ${result.exitCode})${output ? `: ${output}` : ''}`)
    }
  }

  // Ensure worktree tracks the requested head branch (not just base).
  assertCommandSuccess(await runCommand('git', ['fetch', '--all', '--prune'], { cwd: worktree }), 'git fetch')

  const syncWorktreeToHead = async () => {
    const remoteHeadExists =
      (
        await runCommand('git', ['rev-parse', '--verify', '--quiet', `origin/${headBranch}`], {
          cwd: worktree,
        })
      ).exitCode === 0

    const checkoutResult = await runCommand('git', ['checkout', headBranch], { cwd: worktree })
    if (checkoutResult.exitCode !== 0) {
      const fromRef = remoteHeadExists ? `origin/${headBranch}` : `origin/${baseBranch}`
      assertCommandSuccess(
        await runCommand('git', ['checkout', '-B', headBranch, fromRef], { cwd: worktree }),
        'git checkout -B head',
      )
    } else {
      assertCommandSuccess(checkoutResult, 'git checkout head')
    }

    const candidateRefs = remoteHeadExists ? [`origin/${headBranch}`, `origin/${baseBranch}`] : [`origin/${baseBranch}`]

    const resetErrors: string[] = []
    for (const ref of candidateRefs) {
      const resetResult = await runCommand('git', ['reset', '--hard', ref], { cwd: worktree })
      if (resetResult.exitCode === 0) {
        assertCommandSuccess(resetResult, `git reset --hard ${ref}`)
        return
      }
      resetErrors.push(`reset ${ref} failed (exit ${resetResult.exitCode}) ${resetResult.stderr || resetResult.stdout}`)
    }

    throw new Error(`git reset --hard failed; attempts: ${resetErrors.join('; ')}`)
  }

  await syncWorktreeToHead()

  const planCommentId =
    event.planCommentId !== undefined && event.planCommentId !== null ? String(event.planCommentId) : ''
  const planCommentUrl = sanitizeNullableString(event.planCommentUrl)
  const planCommentBody = sanitizeNullableString(event.planCommentBody)
  let issueTitle = sanitizeNullableString(event.issueTitle ?? process.env.ISSUE_TITLE ?? '')
  let issueBody = sanitizeNullableString(event.issueBody ?? '')
  let issueUrl = sanitizeNullableString(event.issueUrl ?? '')

  if (!prompt) {
    throw new Error('Missing Codex prompt in event payload')
  }

  process.env.CODEX_PROMPT = prompt
  process.env.ISSUE_REPO = repository
  process.env.ISSUE_NUMBER = issueNumber
  process.env.CODEX_REPOSITORY = repository
  process.env.CODEX_ISSUE_NUMBER = issueNumber
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch
  process.env.CODEX_BRANCH = headBranch
  process.env.PLAN_COMMENT_ID = planCommentId
  process.env.PLAN_COMMENT_URL = planCommentUrl
  process.env.PLAN_COMMENT_BODY = planCommentBody
  process.env.WORKTREE = worktree
  process.env.OUTPUT_PATH = outputPath
  process.env.ISSUE_TITLE = issueTitle
  process.env.CODEX_ITERATION = iteration !== null && iteration !== undefined ? String(iteration) : ''
  process.env.CODEX_ITERATION_CYCLE =
    iterationCycle !== null && iterationCycle !== undefined ? String(iterationCycle) : ''
  process.env.CODEX_ITERATIONS_COUNT = iterations !== null && iterations !== undefined ? String(iterations) : ''
  process.env.IMPLEMENTATION_PATCH_PATH = patchPath
  process.env.IMPLEMENTATION_STATUS_PATH = statusPath
  process.env.IMPLEMENTATION_CHANGES_ARCHIVE_PATH = archivePath
  process.env.IMPLEMENTATION_NOTIFY_PATH = notifyPath
  process.env.NATS_CONTEXT_PATH = natsContextPath
  process.env.COMMIT_SHA_PATH = commitShaPath
  process.env.PR_NUMBER_PATH = prNumberPath
  process.env.PR_URL_PATH = prUrlPath

  process.env.CODEX_STAGE = stage
  process.env.RUST_LOG = process.env.RUST_LOG ?? 'codex_core=info,codex_exec=info'
  process.env.RUST_BACKTRACE = process.env.RUST_BACKTRACE ?? '1'

  const envChannelScript = sanitizeNullableString(process.env.CHANNEL_SCRIPT ?? '')
  const imageChannelScript = '/usr/local/bin/discord-channel.ts'
  const repoChannelScript = 'apps/froussard/scripts/discord-channel.ts'
  const channelScript =
    envChannelScript || ((await pathExists(imageChannelScript)) ? imageChannelScript : repoChannelScript)
  const channelTimestamp = timestampUtc()
  const channelRunIdSource =
    process.env.CODEX_CHANNEL_RUN_ID ?? process.env.ARGO_WORKFLOW_NAME ?? process.env.ARGO_WORKFLOW_UID ?? randomRunId()
  const channelRunId = channelRunIdSource.slice(0, 24).toLowerCase()

  await initializeOutputFiles(
    [
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      runtimeLogPath,
      notifyPath,
      patchPath,
      statusPath,
      archivePath,
      manifestPath,
      headShaPath,
      commitShaPath,
      prNumberPath,
      prUrlPath,
      natsContextPath,
    ],
    consoleLogger,
  )

  const logger = await createCodexLogger({
    logPath: runtimeLogPath,
    context: {
      stage,
      repository,
      issue: issueNumber,
      workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
      namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
      run_id: channelRunId || undefined,
    },
  })

  const natsSoakRequired =
    (process.env.CODEX_NATS_SOAK_REQUIRED ?? 'true').trim().toLowerCase() !== 'false' &&
    (process.env.CODEX_NATS_SOAK_REQUIRED ?? 'true').trim() !== '0'

  const shouldRequireMemories = stage === 'implementation' && ((iteration ?? 1) >= 2 || (iterationCycle ?? 1) >= 2)
  const memoryNamespace = `codex:${repository}:${issueNumber}`
  const memoryQuery = `issue ${issueNumber} ${issueTitle || repository} codex run summary`
  const memorySoak = await fetchJangarMemories({
    logger,
    required: shouldRequireMemories,
    namespace: memoryNamespace,
    query: memoryQuery,
    limit: 12,
  })
  const memoryContextBlock = formatMemoryContextBlock(memorySoak)
  if (memoryContextBlock) {
    prompt = `${memoryContextBlock}\n\n${prompt}`
  }

  const natsContext = await fetchNatsContext({
    logger,
    required: natsSoakRequired,
    outputPath: natsContextPath,
  })
  const natsContextBlock = formatNatsContextBlock(natsContext)
  if (natsContextBlock) {
    prompt = `${natsContextBlock}\n\n${prompt}`
  }

  await ensureEmptyFile(outputPath)
  await ensureEmptyFile(jsonOutputPath)
  await ensureEmptyFile(agentOutputPath)
  await ensureEmptyFile(runtimeLogPath)

  if (process.env.CODEX_SKIP_RUN_STARTED !== '1') {
    await publishNatsEvent(logger, {
      kind: 'run-started',
      content: `${stage} started`,
      attrs: { stage, iteration, iterationCycle },
    })
  }

  const normalizedIssueNumber = issueNumber
  const supportsResume = stage === 'implementation'
  let prInfo: PullRequestInfo | null = null
  let resumeContext: ResumeContext | undefined
  let resumeSessionId: string | undefined
  let capturedSessionId: string | undefined
  let runSucceeded = false

  try {
    if (supportsResume) {
      resumeContext = await loadResumeMetadata({
        worktree,
        repository,
        issueNumber: normalizedIssueNumber,
        logger,
      })

      if (resumeContext) {
        logger.info(
          `Found pending resume state from ${resumeContext.metadata.generatedAt}; attempting to restore implementation changes`,
        )
        const applied = await applyResumeContext({ worktree, context: resumeContext, logger })
        if (applied) {
          if (resumeContext.metadata.sessionId && resumeContext.metadata.sessionId.trim().length > 0) {
            resumeSessionId = resumeContext.metadata.sessionId.trim()
            logger.info(`Resuming Codex session ${resumeSessionId}`)
          } else {
            resumeSessionId = '--last'
            logger.warn('Resume metadata missing session id; falling back to --last to resume the latest Codex session')
          }
        } else {
          logger.warn('Failed to restore resume archive; proceeding with a fresh Codex session')
        }
      }
    }

    capturedSessionId = resumeSessionId

    let discordChannelCommand: string[] | undefined
    const discordToken = process.env.DISCORD_BOT_TOKEN ?? ''
    const discordGuild = process.env.DISCORD_GUILD_ID ?? ''
    const discordScriptExists = await pathExists(channelScript)

    if (discordToken && discordGuild && discordScriptExists) {
      const args = ['--stage', stage, '--repo', repository, '--issue', issueNumber, '--timestamp', channelTimestamp]
      if (channelRunId) {
        args.push('--run-id', channelRunId)
      }
      if (issueTitle) {
        args.push('--title', issueTitle)
      }
      if (process.env.DISCORD_CHANNEL_DRY_RUN === '1') {
        args.push('--dry-run')
      }
      try {
        discordChannelCommand = await buildDiscordChannelCommand(channelScript, args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`Discord channel disabled: ${message}`)
      }
    } else {
      logger.warn('Discord channel disabled: missing credentials or channel script')
    }

    if (resumeSessionId) {
      logger.info(`Running Codex ${stage} for ${repository}#${issueNumber} (resume mode)`)
    } else {
      logger.info(`Running Codex ${stage} for ${repository}#${issueNumber}`)
    }

    let sessionResult: RunCodexSessionResult = { agentMessages: [], sessionId: undefined }
    let lastAssistantMessage: string | null = null
    const runSession = async (sessionPrompt: string) => {
      return await runCodexSession({
        stage: stage as Parameters<typeof runCodexSession>[0]['stage'],
        prompt: sessionPrompt,
        outputPath,
        jsonOutputPath,
        agentOutputPath,
        resumeSessionId,
        logger,
        discordChannel: discordChannelCommand
          ? {
              command: discordChannelCommand,
              onError: (error) => logger.error(`Discord channel failed: ${error.message}`),
            }
          : undefined,
      })
    }

    sessionResult = await runSession(prompt)
    lastAssistantMessage =
      sessionResult.agentMessages.length > 0
        ? sessionResult.agentMessages[sessionResult.agentMessages.length - 1]
        : null

    capturedSessionId =
      sessionResult.sessionId ?? resumeContext?.metadata.sessionId ?? capturedSessionId ?? resumeSessionId
    if (capturedSessionId) {
      logger.info(`Codex session id: ${capturedSessionId}`)
    }

    await copyAgentLogIfNeeded(outputPath, agentOutputPath)
    await pushCodexEventsToLoki({
      stage,
      endpoint: lokiEndpoint,
      jsonPath: jsonOutputPath,
      agentLogPath: agentOutputPath,
      runtimeLogPath,
      labels: {
        repository,
        issue: issueNumber,
        workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
        namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
        run_id: channelRunId || undefined,
      },
      tenant: lokiTenant,
      basicAuth: lokiBasicAuth,
      logger,
    })

    if (stage === 'implementation') {
      await commitWorkingTreeIfNeeded({
        worktree,
        issueNumber,
        issueTitle,
        logger,
      })
      await pushHeadBranch({ worktree, headBranch, logger })
    }

    const logExcerpt = await collectLogExcerpts(
      {
        outputPath,
        jsonOutputPath,
        agentOutputPath,
        runtimeLogPath,
        statusPath,
      },
      logger,
    )

    const commitSha = await resolveHeadSha(worktree, logger)

    if (stage === 'implementation') {
      prInfo = await ensurePullRequest({
        repository,
        headBranch,
        baseBranch,
        issueNumber,
        issueTitle,
        lastAssistantMessage,
        logger,
      })
    }
    const prNumber = prInfo?.number ?? null
    const prUrl = prInfo?.url ?? null
    const headSha = prInfo?.headSha ?? commitSha ?? null
    try {
      await ensureFileDirectory(headShaPath)
      await writeFile(headShaPath, headSha ?? '', 'utf8')
    } catch (error) {
      logger.warn('Failed to persist head sha output', error)
    }

    if (stage === 'implementation') {
      try {
        await ensureFileDirectory(commitShaPath)
        await writeFile(commitShaPath, commitSha ?? '', 'utf8')
      } catch (error) {
        logger.warn('Failed to persist commit sha output', error)
      }
      try {
        await ensureFileDirectory(prNumberPath)
        await writeFile(prNumberPath, prNumber ? String(prNumber) : '', 'utf8')
      } catch (error) {
        logger.warn('Failed to persist PR number output', error)
      }
      try {
        await ensureFileDirectory(prUrlPath)
        await writeFile(prUrlPath, prUrl ?? '', 'utf8')
      } catch (error) {
        logger.warn('Failed to persist PR url output', error)
      }
    }

    const notifyPayload = buildNotifyPayload({
      repository,
      issueNumber,
      baseBranch,
      headBranch,
      prompt,
      stage,
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      runtimeLogPath,
      statusPath,
      patchPath,
      archivePath,
      notifyPath,
      manifestPath,
      headShaPath,
      commitShaPath,
      prNumberPath,
      prUrlPath,
      sessionId: capturedSessionId,
      lastAssistantMessage,
      logExcerpt,
      commitSha,
      headSha,
      prNumber,
      prUrl,
      contextSoak: natsContext,
      memorySoak,
      iteration,
      iterationCycle,
      iterations,
    })
    try {
      await ensureFileDirectory(notifyPath)
      await writeFile(notifyPath, JSON.stringify(notifyPayload, null, 2), 'utf8')
    } catch (error) {
      logger.warn('Failed to persist notify payload for artifacts', error)
    }
    await postNotifyPayload(notifyPayload, logger)

    console.log(`Codex execution logged to ${outputPath}`)
    try {
      const jsonStats = await stat(jsonOutputPath)
      if (jsonStats.size > 0) {
        console.log(`Codex JSON events stored at ${jsonOutputPath}`)
      }
    } catch {
      // ignore missing json log
    }

    const summary = extractSummary(lastAssistantMessage)
    const tests = extractTests(lastAssistantMessage)
    const gaps = extractKnownGaps(lastAssistantMessage)
    const decision = 'pass'
    const nextPrompt = 'None'
    await publishNatsEvent(logger, {
      kind: 'run-summary',
      content: summary ?? `${stage} run completed`,
      attrs: {
        stage,
        decision,
        prUrl,
        ciUrl: null,
        iteration,
        iterationCycle,
      },
    })
    await publishNatsEvent(logger, {
      kind: 'run-gaps',
      content: gaps.length > 0 ? gaps.join('; ') : 'None',
      attrs: {
        stage,
        missingItems: gaps,
        suggestedFixes: gaps.length > 0 ? gaps : [],
        iteration,
        iterationCycle,
      },
    })
    await publishNatsEvent(logger, {
      kind: 'run-next-prompt',
      content: nextPrompt ?? 'None',
      attrs: { stage, decision, iteration, iterationCycle },
    })
    await publishNatsEvent(logger, {
      kind: 'run-outcome',
      content: `${stage} completed`,
      attrs: {
        stage,
        decision,
        prUrl,
        ciUrl: null,
        tests,
        iteration,
        iterationCycle,
      },
    })

    runSucceeded = true
    return {
      repository,
      issueNumber,
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      patchPath,
      statusPath,
      archivePath,
      sessionId: capturedSessionId,
    }
  } finally {
    if (!runSucceeded) {
      await publishNatsEvent(logger, {
        kind: 'run-gaps',
        content: 'Run failed before emitting gaps; inspect logs and artifacts.',
        attrs: { stage, missingItems: ['unknown_failure'], suggestedFixes: [], iteration, iterationCycle },
      })
      await publishNatsEvent(logger, {
        kind: 'run-outcome',
        content: `${stage} failed`,
        attrs: { stage, decision: 'fail', iteration, iterationCycle },
      })
    }
    await ensureNotifyPlaceholder(notifyPath, logger)
    try {
      if (stage === 'implementation') {
        try {
          await commitWorkingTreeIfNeeded({
            worktree,
            issueNumber,
            issueTitle,
            logger,
          })
        } catch (error) {
          logger.warn('Failed to auto-commit implementation changes during cleanup', error)
        }
        const baseRef = await resolveBaseRef(worktree, baseBranch, logger)
        await captureImplementationArtifacts({
          worktree,
          archivePath,
          patchPath,
          statusPath,
          manifestPath,
          jsonEventsPath: jsonOutputPath,
          resumeMetadataPath,
          baseRef,
          repository,
          issueNumber: normalizedIssueNumber,
          prompt,
          sessionId: capturedSessionId,
          resumedSessionId: resumeContext?.metadata.sessionId,
          markForResume: !runSucceeded,
          logger,
        })
      }
    } catch (error) {
      logger.error('Failed while finalizing implementation artifacts', error)
    }
    await logger.flush()
  }
}

await runCli(import.meta, async () => {
  const eventPath = process.argv[2]
  if (!eventPath) {
    throw new Error('Usage: codex-implement.ts <event-json-path>')
  }
  await runCodexImplementation(eventPath)
})
