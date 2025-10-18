#!/usr/bin/env bun
import { readFile, stat } from 'node:fs/promises'
import process from 'node:process'

import { buildCodexPrompt, type ReviewContext } from '@/codex'

import { runCli } from './lib/cli'
import { pushCodexEventsToLoki, runCodexSession } from './lib/codex-runner'
import {
  buildDiscordRelayCommand,
  copyAgentLogIfNeeded,
  pathExists,
  randomRunId,
  timestampUtc,
} from './lib/codex-utils'
import { createCodexLogger } from './lib/logger'

interface ReviewThreadPayload {
  summary?: string | null
  url?: string | null
  author?: string | null
}

interface FailingCheckPayload {
  name?: string | null
  conclusion?: string | null
  url?: string | null
  details?: string | null
}

interface ReviewContextPayload {
  summary?: string | null
  reviewThreads?: ReviewThreadPayload[] | null
  failingChecks?: FailingCheckPayload[] | null
  additionalNotes?: (string | null | undefined)[] | null
}

interface ReviewEventPayload {
  repository?: string | null
  issueNumber?: number | string | null
  issueTitle?: string | null
  issueBody?: string | null
  issueUrl?: string | null
  base?: string | null
  head?: string | null
  reviewContext?: ReviewContextPayload | null
}

const readEventPayload = async (path: string): Promise<ReviewEventPayload> => {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as ReviewEventPayload
  } catch (error) {
    throw new Error(
      `Failed to parse event payload at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const sanitizeString = (value: string | null | undefined, fallback = ''): string => {
  if (!value || value === 'null') {
    return fallback
  }
  return value
}

const sanitizeOptionalString = (value: string | null | undefined): string | undefined => {
  const trimmed = sanitizeString(value).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const ensureString = (value: string | null | undefined, message: string): string => {
  const sanitized = sanitizeString(value).trim()
  if (!sanitized) {
    throw new Error(message)
  }
  return sanitized
}

const toNumericIssue = (value: number | string | null | undefined, message: string): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  throw new Error(message)
}

const buildReviewContext = (payload: ReviewContextPayload | null | undefined): ReviewContext => {
  const summary = sanitizeOptionalString(payload?.summary)
  const reviewThreads = Array.isArray(payload?.reviewThreads)
    ? (payload?.reviewThreads ?? [])
        .map((thread) => ({
          summary: sanitizeString(thread.summary),
          url: sanitizeOptionalString(thread.url),
          author: sanitizeOptionalString(thread.author),
        }))
        .filter((thread) => thread.summary.length > 0)
    : []

  const failingChecks = Array.isArray(payload?.failingChecks)
    ? (payload?.failingChecks ?? [])
        .map((check) => ({
          name: sanitizeString(check.name),
          conclusion: sanitizeOptionalString(check.conclusion),
          url: sanitizeOptionalString(check.url),
          details: sanitizeOptionalString(check.details),
        }))
        .filter((check) => check.name.length > 0)
    : []

  const additionalNotes = Array.isArray(payload?.additionalNotes)
    ? (payload?.additionalNotes ?? []).map((note) => sanitizeString(note).trim()).filter((note) => note.length > 0)
    : []

  return {
    summary,
    reviewThreads,
    failingChecks,
    additionalNotes: additionalNotes.length > 0 ? additionalNotes : undefined,
  }
}

export const runCodexReview = async (eventPath: string) => {
  if (!(await pathExists(eventPath))) {
    throw new Error(`Event payload file not found at '${eventPath}'`)
  }

  const event = await readEventPayload(eventPath)

  const repository = ensureString(event.repository, 'Missing repository metadata in event payload')
  const issueNumberValue = toNumericIssue(event.issueNumber, 'Missing issue number metadata in event payload')
  const issueNumber = String(issueNumberValue)
  const baseBranch = sanitizeString(event.base) || process.env.BASE_BRANCH || 'main'
  const headBranch = ensureString(event.head, 'Missing Codex branch metadata in event payload')
  const issueTitle = sanitizeString(event.issueTitle ?? process.env.ISSUE_TITLE ?? '')
  const issueBody = sanitizeString(event.issueBody ?? '')
  const issueUrl = sanitizeOptionalString(event.issueUrl ?? process.env.ISSUE_URL)

  const reviewContext = buildReviewContext(event.reviewContext)

  const prompt = buildCodexPrompt({
    stage: 'review',
    issueTitle,
    issueBody,
    repositoryFullName: repository,
    issueNumber: issueNumberValue,
    baseBranch,
    headBranch,
    issueUrl: issueUrl ?? '',
    reviewContext,
  })

  const worktree = process.env.WORKTREE ?? '/workspace/lab'
  const defaultOutputPath = `${worktree}/.codex-review.log`
  const outputPath = process.env.OUTPUT_PATH ?? defaultOutputPath
  const jsonOutputPath = process.env.JSON_OUTPUT_PATH ?? `${worktree}/.codex-review-events.jsonl`
  const agentOutputPath = process.env.AGENT_OUTPUT_PATH ?? `${worktree}/.codex-review-agent.log`
  const runtimeLogPath = process.env.CODEX_RUNTIME_LOG_PATH ?? `${worktree}/.codex-review-runtime.log`
  const lokiEndpoint =
    process.env.LGTM_LOKI_ENDPOINT ??
    'http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push'
  const lokiTenant = process.env.LGTM_LOKI_TENANT
  const lokiBasicAuth = process.env.LGTM_LOKI_BASIC_AUTH

  process.env.CODEX_PROMPT = prompt
  process.env.ISSUE_REPO = repository
  process.env.ISSUE_NUMBER = issueNumber
  process.env.BASE_BRANCH = baseBranch
  process.env.HEAD_BRANCH = headBranch
  process.env.ISSUE_TITLE = issueTitle
  if (issueUrl) {
    process.env.ISSUE_URL = issueUrl
  }
  process.env.WORKTREE = worktree
  process.env.OUTPUT_PATH = outputPath

  process.env.CODEX_STAGE = process.env.CODEX_STAGE ?? 'review'
  process.env.RUST_LOG = process.env.RUST_LOG ?? 'codex_core=info,codex_exec=info'
  process.env.RUST_BACKTRACE = process.env.RUST_BACKTRACE ?? '1'

  const relayScript = process.env.RELAY_SCRIPT ?? 'apps/froussard/scripts/discord-relay.ts'
  const relayTimestamp = timestampUtc()
  const relayRunIdSource =
    process.env.CODEX_RELAY_RUN_ID ?? process.env.ARGO_WORKFLOW_NAME ?? process.env.ARGO_WORKFLOW_UID ?? randomRunId()
  const relayRunId = relayRunIdSource.slice(0, 24).toLowerCase()

  const logger = await createCodexLogger({
    logPath: runtimeLogPath,
    context: {
      stage: 'review',
      repository,
      issue: issueNumber,
      workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
      namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
      run_id: relayRunId || undefined,
    },
  })

  try {
    let discordRelayCommand: string[] | undefined
    const discordToken = process.env.DISCORD_BOT_TOKEN ?? ''
    const discordGuild = process.env.DISCORD_GUILD_ID ?? ''
    const discordScriptExists = await pathExists(relayScript)

    if (discordToken && discordGuild && discordScriptExists) {
      const args = ['--stage', 'review', '--repo', repository, '--issue', issueNumber, '--timestamp', relayTimestamp]
      if (relayRunId) {
        args.push('--run-id', relayRunId)
      }
      if (reviewContext.summary) {
        args.push('--summary', reviewContext.summary)
      }
      if (process.env.DISCORD_RELAY_DRY_RUN === '1') {
        args.push('--dry-run')
      }

      try {
        discordRelayCommand = await buildDiscordRelayCommand(relayScript, args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`Discord relay disabled: ${message}`)
      }
    } else {
      logger.warn('Discord relay disabled: missing credentials or relay script')
    }

    logger.info(`Running Codex review for ${repository}#${issueNumber}`)

    await runCodexSession({
      stage: 'review',
      prompt,
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      logger,
      discordRelay: discordRelayCommand
        ? {
            command: discordRelayCommand,
            onError: (error) => logger.error(`Discord relay failed: ${error.message}`),
          }
        : undefined,
    })

    await copyAgentLogIfNeeded(outputPath, agentOutputPath)
    await pushCodexEventsToLoki({
      stage: 'review',
      endpoint: lokiEndpoint,
      jsonPath: jsonOutputPath,
      agentLogPath: agentOutputPath,
      runtimeLogPath,
      labels: {
        repository,
        issue: issueNumber,
        workflow: process.env.ARGO_WORKFLOW_NAME ?? undefined,
        namespace: process.env.ARGO_WORKFLOW_NAMESPACE ?? undefined,
        run_id: relayRunId || undefined,
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

    return {
      repository,
      issueNumber,
      outputPath,
      jsonOutputPath,
      agentOutputPath,
    }
  } finally {
    await logger.flush()
  }
}

await runCli(import.meta, async () => {
  const eventPath = process.argv[2]
  if (!eventPath) {
    throw new Error('Usage: codex-review.ts <event-json-path>')
  }
  await runCodexReview(eventPath)
})
