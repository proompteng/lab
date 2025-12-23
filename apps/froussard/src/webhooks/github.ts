import { randomUUID } from 'node:crypto'

import type { Webhooks } from '@octokit/webhooks'
import { Effect } from 'effect'
import type { Effect as EffectType } from 'effect/Effect'
import * as TSemaphore from 'effect/TSemaphore'

import type { AppConfigService } from '@/effect/config'
import type { AppRuntime } from '@/effect/runtime'
import { type AppLogger, logger } from '@/logger'
import { GithubService } from '@/services/github/service'
import type { KafkaProducer } from '@/services/kafka'

import { handleIssueCommentCreated, handleIssueOpened } from './github/events/issues'
import { handlePullRequestEvent } from './github/events/pull-request'
import type { WorkflowExecutionContext, WorkflowStage } from './github/workflow'
import type { WebhookConfig } from './types'
import { publishKafkaMessage } from './utils'

const ATLAS_ENRICH_PATH = '/api/enrich'
const MAX_ATLAS_ERROR_DETAIL = 500

export interface GithubWebhookDependencies {
  runtime: AppRuntime
  webhooks: Webhooks
  config: WebhookConfig
}

const buildHeaders = (
  deliveryId: string,
  eventName: string,
  signatureHeader: string,
  contentType: string,
  hookId: string,
  actionValue?: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    'x-github-delivery': deliveryId,
    'x-github-event': eventName,
    'x-github-hook-id': hookId,
    'content-type': contentType,
    'x-hub-signature-256': signatureHeader,
  }

  if (actionValue) {
    headers['x-github-action'] = actionValue
  }

  return headers
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

const extractAtlasContext = (payload: unknown): { repository?: string; ref?: string; commit?: string } => {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const repository =
    typeof (payload as { repository?: { full_name?: unknown } }).repository?.full_name === 'string'
      ? (payload as { repository: { full_name: string } }).repository.full_name
      : undefined

  const repositoryUrl =
    typeof (payload as { issue?: { repository_url?: unknown } }).issue?.repository_url === 'string'
      ? (payload as { issue: { repository_url: string } }).issue.repository_url
      : undefined

  const fallbackRepository =
    typeof (payload as { pull_request?: { base?: { repo?: { full_name?: unknown } } } }).pull_request?.base?.repo
      ?.full_name === 'string'
      ? (payload as { pull_request: { base: { repo: { full_name: string } } } }).pull_request.base.repo.full_name
      : undefined

  const ref =
    typeof (payload as { ref?: unknown }).ref === 'string'
      ? (payload as { ref: string }).ref
      : typeof (payload as { pull_request?: { base?: { ref?: unknown } } }).pull_request?.base?.ref === 'string'
        ? (payload as { pull_request: { base: { ref: string } } }).pull_request.base.ref
        : typeof (payload as { repository?: { default_branch?: unknown } }).repository?.default_branch === 'string'
          ? (payload as { repository: { default_branch: string } }).repository.default_branch
          : undefined

  const commit =
    typeof (payload as { after?: unknown }).after === 'string'
      ? (payload as { after: string }).after
      : typeof (payload as { pull_request?: { head?: { sha?: unknown } } }).pull_request?.head?.sha === 'string'
        ? (payload as { pull_request: { head: { sha: string } } }).pull_request.head.sha
        : typeof (payload as { head_commit?: { id?: unknown } }).head_commit?.id === 'string'
          ? (payload as { head_commit: { id: string } }).head_commit.id
          : undefined

  return {
    repository:
      repository ?? fallbackRepository ?? (repositoryUrl ? extractRepositoryFromUrl(repositoryUrl) : undefined),
    ref,
    commit,
  }
}

const buildAtlasPayload = (options: {
  payload: unknown
  deliveryId: string
  eventName: string
  actionValue?: string
  hookId: string
  senderLogin?: string
  workflowIdentifier?: string | null
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
      workflowIdentifier: options.workflowIdentifier ?? null,
      identifiers: options.identifiers,
      receivedAt: new Date().toISOString(),
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
  senderLogin?: string
  workflowIdentifier?: string | null
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
      senderLogin: options.senderLogin,
      workflowIdentifier: options.workflowIdentifier,
      identifiers: options.identifiers,
    }),
  )

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, MAX_ATLAS_ERROR_DETAIL)
      logger.warn(
        {
          deliveryId: options.deliveryId,
          eventName: options.eventName,
          action: options.actionValue ?? null,
          status: response.status,
          detail,
        },
        'atlas enrichment request failed',
      )
    } else {
      logger.debug(
        {
          deliveryId: options.deliveryId,
          eventName: options.eventName,
          action: options.actionValue ?? null,
          status: response.status,
        },
        'atlas enrichment request accepted',
      )
    }
  } catch (error) {
    logger.warn(
      {
        deliveryId: options.deliveryId,
        eventName: options.eventName,
        action: options.actionValue ?? null,
        err: error instanceof Error ? error.message : String(error),
      },
      'atlas enrichment request failed',
    )
  }
}

export const createGithubWebhookHandler = ({ runtime, webhooks, config }: GithubWebhookDependencies) => {
  const githubService = runtime.runSync(
    Effect.gen(function* (_) {
      return yield* GithubService
    }),
  )
  const githubSemaphore = TSemaphore.unsafeMake(4)

  const runGithub = <A, E>(
    factory: () => EffectType<A, E, AppLogger | AppConfigService | GithubService | KafkaProducer>,
  ) => runtime.runPromise(TSemaphore.withPermits(githubSemaphore, 1)(factory()))

  return async (rawBody: string, request: Request): Promise<Response> => {
    const signatureHeader = request.headers.get('x-hub-signature-256')
    if (!signatureHeader) {
      logger.error({ headers: Array.from(request.headers.keys()) }, 'missing x-hub-signature-256 header')
      return new Response('Unauthorized', { status: 401 })
    }

    const deliveryId = request.headers.get('x-github-delivery') || randomUUID()

    if (!(await webhooks.verify(rawBody, signatureHeader))) {
      logger.error({ deliveryId, signatureHeader }, 'github webhook signature verification failed')
      return new Response('Unauthorized', { status: 401 })
    }

    let parsedPayload: unknown
    try {
      parsedPayload = JSON.parse(rawBody) as unknown
    } catch (parseError) {
      logger.error({ err: parseError }, 'failed to parse github webhook payload')
      return new Response('Invalid JSON body', { status: 400 })
    }

    const eventName = request.headers.get('x-github-event') ?? 'unknown'
    const actionValue =
      typeof (parsedPayload as { action?: unknown }).action === 'string'
        ? (parsedPayload as { action: string }).action
        : undefined
    const contentType = request.headers.get('content-type') ?? 'application/json'

    const hookId = request.headers.get('x-github-hook-id') ?? 'unknown'

    const headers = buildHeaders(deliveryId, eventName, signatureHeader, contentType, hookId, actionValue)

    const workflowIdentifier =
      process.env.ARGO_WORKFLOW_NAME ?? process.env.ARGO_WORKFLOW_UID ?? process.env.ARGO_WORKFLOW_NAMESPACE ?? null

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
        topics: {
          codexStructured: config.topics.codexStructured,
        },
      },
      deliveryId,
      workflowIdentifier,
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
        workflowIdentifier,
      },
      'github webhook dispatch',
    )

    try {
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

      const atlasPromise = triggerAtlasEnrichment({
        config: config.atlas,
        payload: parsedPayload,
        deliveryId,
        eventName,
        actionValue,
        hookId,
        senderLogin,
        workflowIdentifier,
        identifiers,
      })

      const publishPromise = runtime.runPromise(
        publishKafkaMessage({
          topic: config.topics.raw,
          key: deliveryId,
          value: rawBody,
          headers,
        }),
      )

      const [, publishResult] = await Promise.allSettled([atlasPromise, publishPromise])

      if (publishResult.status === 'rejected') {
        throw publishResult.reason
      }

      return new Response(
        JSON.stringify({
          status: 'accepted',
          deliveryId,
          event: eventName,
          action: actionValue ?? null,
          codexStageTriggered,
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    } catch (error) {
      logger.error(
        { err: error, deliveryId, eventName, action: actionValue ?? null, identifiers },
        'failed to enqueue github webhook event',
      )
      return new Response('Failed to enqueue webhook event', { status: 500 })
    }
  }
}
