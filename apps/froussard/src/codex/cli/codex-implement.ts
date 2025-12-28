#!/usr/bin/env bun
import { spawn as spawnChild } from 'node:child_process'
import { copyFile, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { runCli } from './lib/cli'
import { pushCodexEventsToLoki, runCodexSession } from './lib/codex-runner'
import {
  buildDiscordChannelCommand,
  copyAgentLogIfNeeded,
  pathExists,
  randomRunId,
  timestampUtc,
} from './lib/codex-utils'
import { ensureFileDirectory } from './lib/fs'
import { type CodexLogger, createCodexLogger } from './lib/logger'

interface ImplementationEventPayload {
  prompt?: string
  repository?: string
  issueNumber?: number | string
  issueTitle?: string | null
  base?: string | null
  head?: string | null
  planCommentId?: number | string | null
  planCommentUrl?: string | null
  planCommentBody?: string | null
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

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

const sleep = async (durationMs: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })

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

interface CaptureImplementationArtifactsOptions {
  worktree: string
  archivePath: string
  patchPath: string
  statusPath: string
  jsonEventsPath?: string
  resumeMetadataPath: string
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
  prompt: string
  sessionId?: string
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
  jsonEventsPath,
  resumeMetadataPath,
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

    let diffContent = ''
    try {
      const diffResult = await runCommand('git', ['diff', '--binary', 'HEAD'], { cwd: worktree })
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
      const trackedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], {
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
      const deletedResult = await runCommand('git', ['diff', '--name-only', '--diff-filter=D', 'HEAD'], {
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

    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      worktree,
      repository,
      issueNumber,
      prompt,
      sessionId: sessionId ?? (await extractSessionIdFromEvents(jsonEventsPath, logger)),
      trackedFiles: Array.from(trackedFiles).sort(),
      deletedFiles: deletedFiles.sort(),
    } satisfies ImplementationManifest

    await ensureFileDirectory(join(metadataDir, 'manifest.json'))
    await writeFile(join(metadataDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

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

  const prompt = event.prompt?.trim()
  if (!prompt) {
    throw new Error('Missing Codex prompt in event payload')
  }

  const repository = event.repository?.trim()
  if (!repository) {
    throw new Error('Missing repository metadata in event payload')
  }

  const issueNumberRaw = event.issueNumber
  const issueNumber = issueNumberRaw !== undefined && issueNumberRaw !== null ? String(issueNumberRaw) : ''
  if (!issueNumber) {
    throw new Error('Missing issue number metadata in event payload')
  }

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
  const issueTitle = sanitizeNullableString(event.issueTitle ?? process.env.ISSUE_TITLE ?? '')

  process.env.CODEX_PROMPT = prompt
  process.env.ISSUE_REPO = repository
  process.env.ISSUE_NUMBER = issueNumber
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch
  process.env.PLAN_COMMENT_ID = planCommentId
  process.env.PLAN_COMMENT_URL = planCommentUrl
  process.env.PLAN_COMMENT_BODY = planCommentBody
  process.env.WORKTREE = worktree
  process.env.OUTPUT_PATH = outputPath
  process.env.ISSUE_TITLE = issueTitle
  process.env.IMPLEMENTATION_PATCH_PATH = patchPath
  process.env.IMPLEMENTATION_STATUS_PATH = statusPath
  process.env.IMPLEMENTATION_CHANGES_ARCHIVE_PATH = archivePath

  process.env.CODEX_STAGE = process.env.CODEX_STAGE ?? 'implementation'
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

  const logger = await createCodexLogger({
    logPath: runtimeLogPath,
    context: {
      stage: 'implementation',
      repository,
      issue: issueNumber,
      workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
      namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
      run_id: channelRunId || undefined,
    },
  })

  await ensureEmptyFile(outputPath)
  await ensureEmptyFile(jsonOutputPath)
  await ensureEmptyFile(agentOutputPath)
  await ensureEmptyFile(runtimeLogPath)

  const normalizedIssueNumber = issueNumber
  let resumeContext: ResumeContext | undefined
  let resumeSessionId: string | undefined
  let capturedSessionId: string | undefined
  let runSucceeded = false

  try {
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

    capturedSessionId = resumeSessionId

    let discordChannelCommand: string[] | undefined
    const discordToken = process.env.DISCORD_BOT_TOKEN ?? ''
    const discordGuild = process.env.DISCORD_GUILD_ID ?? ''
    const discordScriptExists = await pathExists(channelScript)

    if (discordToken && discordGuild && discordScriptExists) {
      const args = [
        '--stage',
        'implementation',
        '--repo',
        repository,
        '--issue',
        issueNumber,
        '--timestamp',
        channelTimestamp,
      ]
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
      logger.info(`Running Codex implementation for ${repository}#${issueNumber} (resume mode)`)
    } else {
      logger.info(`Running Codex implementation for ${repository}#${issueNumber}`)
    }

    const sessionResult = await runCodexSession({
      stage: 'implementation',
      prompt,
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
    capturedSessionId =
      sessionResult.sessionId ?? resumeContext?.metadata.sessionId ?? capturedSessionId ?? resumeSessionId
    if (capturedSessionId) {
      logger.info(`Codex session id: ${capturedSessionId}`)
    }

    await copyAgentLogIfNeeded(outputPath, agentOutputPath)
    await pushCodexEventsToLoki({
      stage: 'implementation',
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

    console.log(`Codex execution logged to ${outputPath}`)
    try {
      const jsonStats = await stat(jsonOutputPath)
      if (jsonStats.size > 0) {
        console.log(`Codex JSON events stored at ${jsonOutputPath}`)
      }
    } catch {
      // ignore missing json log
    }

    await ensurePullRequestExists(repository, headBranch, logger)
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
    try {
      await captureImplementationArtifacts({
        worktree,
        archivePath,
        patchPath,
        statusPath,
        jsonEventsPath: jsonOutputPath,
        resumeMetadataPath,
        repository,
        issueNumber: normalizedIssueNumber,
        prompt,
        sessionId: capturedSessionId,
        resumedSessionId: resumeContext?.metadata.sessionId,
        markForResume: !runSucceeded,
        logger,
      })
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
