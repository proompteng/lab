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
          codex: config.topics.codex,
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

      await runtime.runPromise(
        publishKafkaMessage({
          topic: config.topics.raw,
          key: deliveryId,
          value: rawBody,
          headers,
        }),
      )

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
