import { Effect, pipe } from 'effect'
import type { Effect as EffectType } from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import type { AppConfigService } from '@/effect/config'
import type { AppRuntime } from '@/effect/runtime'
import { type AppLogger, logger } from '@/logger'
import { makeAgentsServiceSubmitter } from '@/services/agents'
import { GithubService } from '@/services/github/service'
import type { KafkaProducer } from '@/services/kafka'

import { handleIssueCommentCreated, handleIssueOpened } from './github/events/issues'
import { handlePullRequestEvent, handleReadinessEvent } from './github/events/pull-request'
import type { WorkflowExecutionContext, WorkflowStage } from './github/workflow'
import type { WebhookAdmission } from './admission'
import type { WebhookConfig } from './types'
import { publishKafkaMessage } from './utils'

const ATLAS_ENRICH_PATH = '/api/enrich'

export interface GithubPolicyDependencies {
  runtime: AppRuntime
  config: WebhookConfig
}

const extractEventIdentifiers = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const repositoryFullName =
    typeof (payload as { repository?: { full_name?: unknown } }).repository?.full_name === 'string'
      ? (payload as { repository: { full_name: string } }).repository.full_name
      : undefined

  const issueNumber =
    typeof (payload as { issue?: { number?: unknown } }).issue?.number === 'number'
      ? (payload as { issue: { number: number } }).issue.number
      : undefined

  const pullNumber =
    typeof (payload as { pull_request?: { number?: unknown } }).pull_request?.number === 'number'
      ? (payload as { pull_request: { number: number } }).pull_request.number
      : undefined

  const commentId =
    typeof (payload as { comment?: { id?: unknown } }).comment?.id === 'number'
      ? (payload as { comment: { id: number } }).comment.id
      : undefined

  const discussionId =
    typeof (payload as { discussion?: { node_id?: unknown } }).discussion?.node_id === 'string'
      ? (payload as { discussion: { node_id: string } }).discussion.node_id
      : undefined

  return {
    repositoryFullName,
    issueNumber,
    pullNumber,
    commentId,
    discussionId,
  }
}

const extractRepositoryFromUrl = (repositoryUrl: string): string | undefined => {
  try {
    const parsed = new URL(repositoryUrl)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length >= 2) {
      const owner = segments[segments.length - 2]
      const repo = segments[segments.length - 1]
      if (owner && repo) {
        return `${owner}/${repo}`
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

const AtlasContextSchema = Schema.Struct({
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        full_name: Schema.optional(Schema.NullOr(Schema.String)),
        default_branch: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository_url: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  pull_request: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        base: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              ref: Schema.optional(Schema.NullOr(Schema.String)),
              repo: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    full_name: Schema.optional(Schema.NullOr(Schema.String)),
                  }),
                ),
              ),
            }),
          ),
        ),
        head: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              sha: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  ref: Schema.optional(Schema.NullOr(Schema.String)),
  after: Schema.optional(Schema.NullOr(Schema.String)),
  head_commit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})

const toOptionalString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? Option.some(value) : Option.none()

const extractAtlasContext = (payload: unknown): { repository?: string; ref?: string; commit?: string } => {
  const decoded = Schema.decodeUnknownResult(AtlasContextSchema)(payload)
  if (Result.isFailure(decoded)) return {}
  const value = decoded.success

  const repository = pipe(
    toOptionalString(value.repository?.full_name),
    Option.orElse(() => toOptionalString(value.pull_request?.base?.repo?.full_name)),
    Option.orElse(() =>
      pipe(
        toOptionalString(value.issue?.repository_url),
        Option.map(extractRepositoryFromUrl),
        Option.flatMap(Option.fromNullishOr),
      ),
    ),
    Option.getOrElse(() => undefined),
  )

  const ref = pipe(
    toOptionalString(value.ref),
    Option.orElse(() => toOptionalString(value.pull_request?.base?.ref)),
    Option.orElse(() => toOptionalString(value.repository?.default_branch)),
    Option.getOrElse(() => undefined),
  )

  const commit = pipe(
    toOptionalString(value.after),
    Option.orElse(() => toOptionalString(value.pull_request?.head?.sha)),
    Option.orElse(() => toOptionalString(value.head_commit?.id)),
    Option.getOrElse(() => undefined),
  )

  return { repository, ref, commit }
}

const buildAtlasPayload = (options: {
  payload: unknown
  deliveryId: string
  eventName: string
  actionValue?: string
  hookId: string
  receivedAt: string
  senderLogin?: string
  agentRunIdentifier?: string | null
  identifiers: ReturnType<typeof extractEventIdentifiers>
}) => {
  const context = extractAtlasContext(options.payload)

  return {
    repository: context.repository,
    ref: context.ref,
    commit: context.commit,
    metadata: {
      source: 'github',
      deliveryId: options.deliveryId,
      event: options.eventName,
      action: options.actionValue ?? null,
      hookId: options.hookId,
      sender: options.senderLogin ?? null,
      agentRunIdentifier: options.agentRunIdentifier ?? null,
      identifiers: options.identifiers,
      receivedAt: options.receivedAt,
      payload: options.payload,
    },
  }
}

const triggerAtlasEnrichment = async (options: {
  config: WebhookConfig['atlas']
  payload: unknown
  deliveryId: string
  eventName: string
  actionValue?: string
  hookId: string
  receivedAt: string
  senderLogin?: string
  agentRunIdentifier?: string | null
  identifiers: ReturnType<typeof extractEventIdentifiers>
}): Promise<void> => {
  const url = `${options.config.baseUrl}${ATLAS_ENRICH_PATH}`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-idempotency-key': options.deliveryId,
    'x-github-delivery': options.deliveryId,
    'x-github-event': options.eventName,
    'x-github-hook-id': options.hookId,
  }

  if (options.actionValue) {
    headers['x-github-action'] = options.actionValue
  }

  if (options.config.apiKey) {
    headers.authorization = `Bearer ${options.config.apiKey}`
  }

  const body = JSON.stringify(
    buildAtlasPayload({
      payload: options.payload,
      deliveryId: options.deliveryId,
      eventName: options.eventName,
      actionValue: options.actionValue,
      hookId: options.hookId,
      receivedAt: options.receivedAt,
      senderLogin: options.senderLogin,
      agentRunIdentifier: options.agentRunIdentifier,
      identifiers: options.identifiers,
    }),
  )

  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`Atlas enrichment failed: HTTP ${response.status}`)
  logger.debug({ deliveryId: options.deliveryId, status: response.status }, 'atlas enrichment request accepted')
}

export const createGithubPolicyProcessor = ({ runtime, config }: GithubPolicyDependencies) => {
  const githubService = runtime.runSync(
    Effect.gen(function* () {
      return yield* GithubService
    }),
  )
  const githubSemaphore = Semaphore.makeUnsafe(4)

  const runGithub = <A, E>(
    factory: () => EffectType<A, E, AppLogger | AppConfigService | GithubService | KafkaProducer>,
  ) => runtime.runPromise(Semaphore.withPermits(githubSemaphore, 1)(factory()))

  return async ({ body: rawBody, deliveryId, receivedAt, headers }: WebhookAdmission): Promise<void> => {
    const parsedPayload: unknown = JSON.parse(rawBody)
    const eventName = headers['x-github-event'] ?? 'unknown'
    const actionValue =
      typeof (parsedPayload as { action?: unknown })?.action === 'string'
        ? (parsedPayload as { action: string }).action
        : undefined
    const hookId = headers['x-github-hook-id'] ?? 'unknown'

    const agentRunIdentifier =
      process.env.AGENT_RUN_NAME ?? process.env.AGENT_RUN_UID ?? process.env.AGENT_RUN_NAMESPACE ?? null

    const executionContext: WorkflowExecutionContext = {
      runtime,
      githubService,
      runGithub,
      config: {
        github: {
          token: config.github.token,
          apiBaseUrl: config.github.apiBaseUrl,
          userAgent: config.github.userAgent,
        },
      },
      deliveryId,
      receivedAt: new Date(receivedAt).toISOString(),
      agentRunIdentifier,
      submitAgentRun: makeAgentsServiceSubmitter(config.agents),
    }

    let codexStageTriggered: WorkflowStage | null = null
    const senderLogin =
      typeof (parsedPayload as { sender?: { login?: unknown } }).sender?.login === 'string'
        ? (parsedPayload as { sender: { login: string } }).sender.login
        : undefined

    const identifiers = extractEventIdentifiers(parsedPayload)

    logger.info(
      {
        deliveryId,
        eventName,
        action: actionValue ?? null,
        sender: senderLogin ?? null,
        repository: identifiers.repositoryFullName ?? null,
        issueNumber: identifiers.issueNumber ?? null,
        pullNumber: identifiers.pullNumber ?? null,
        commentId: identifiers.commentId ?? null,
        discussionId: identifiers.discussionId ?? null,
        agentRunIdentifier,
      },
      'github webhook dispatch',
    )

    if (eventName === 'issues' && actionValue === 'opened') {
      const stage = await handleIssueOpened({
        parsedPayload,
        headers,
        config,
        executionContext,
        deliveryId,
        senderLogin,
      })
      if (stage) {
        codexStageTriggered = stage
      }
    }

    if (eventName === 'issue_comment' && actionValue === 'created') {
      const stage = await handleIssueCommentCreated({
        parsedPayload,
        headers,
        config,
        executionContext,
        deliveryId,
        senderLogin,
      })
      if (stage) {
        codexStageTriggered = stage
      }
    }

    if (eventName === 'pull_request') {
      const stage = await handlePullRequestEvent({
        parsedPayload,
        headers,
        config,
        executionContext,
        deliveryId,
        actionValue,
        senderLogin,
      })
      if (stage) {
        codexStageTriggered = stage
      }
    }

    await handleReadinessEvent({
      parsedPayload,
      headers,
      config,
      executionContext,
      deliveryId,
      actionValue,
      senderLogin,
      eventName,
    })

    if (eventName === 'push') {
      await triggerAtlasEnrichment({
        config: config.atlas,
        payload: parsedPayload,
        deliveryId,
        eventName,
        actionValue,
        hookId,
        receivedAt: new Date(receivedAt).toISOString(),
        senderLogin,
        agentRunIdentifier,
        identifiers,
      })
    }

    await runtime.runPromise(
      publishKafkaMessage({
        topic: config.topics.raw,
        key: deliveryId,
        value: rawBody,
        headers,
      }),
    )

    logger.info({ deliveryId, eventName, codexStageTriggered }, 'github policy completed')
  }
}
