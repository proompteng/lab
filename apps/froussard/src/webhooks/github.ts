import { randomUUID } from 'node:crypto'
import { Timestamp } from '@bufbuild/protobuf'
import type { Webhooks } from '@octokit/webhooks'
import { Effect } from 'effect'

import { buildCodexBranchName, buildCodexPrompt, type CodexTaskMessage, normalizeLogin } from '@/codex'
import { selectReactionRepository } from '@/codex-workflow'
import type { AppRuntime } from '@/effect/runtime'
import {
  deriveRepositoryFullName,
  type GithubRepository,
  isGithubIssueCommentEvent,
  isGithubIssueEvent,
} from '@/github-payload'
import { logger } from '@/logger'
import {
  CodexTaskStage,
  CodexFailingCheck as GithubCodexFailingCheck,
  CodexReviewContext as GithubCodexReviewContext,
  CodexReviewThread as GithubCodexReviewThread,
  CodexTask as GithubCodexTaskMessage,
} from '@/proto/github/v1/codex_task_pb'
import { GithubService } from '@/services/github'

import type { WebhookConfig } from './types'
import { publishKafkaMessage } from './utils'

export interface GithubWebhookDependencies {
  runtime: AppRuntime
  webhooks: Webhooks
  config: WebhookConfig
}

const PROTO_CONTENT_TYPE = 'application/x-protobuf'
const PROTO_CODEX_TASK_FULL_NAME = 'github.v1.CodexTask'
const PROTO_CODEX_TASK_SCHEMA = 'github/v1/codex_task.proto'
const CODEX_PLAN_MARKER = '<!-- codex:plan -->'
const CODEX_REVIEW_COMMENT = '@codex review'

const toNumericId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

const parseIssueNumberFromBranch = (branch: string, prefix: string): number | null => {
  if (typeof branch !== 'string' || branch.length === 0) {
    return null
  }
  const normalizedPrefix = prefix.toLowerCase()
  const normalizedBranch = branch.toLowerCase()
  if (normalizedBranch.startsWith(normalizedPrefix)) {
    const remainder = branch.slice(prefix.length)
    const match = remainder.match(/^(\d+)/)
    if (match) {
      const parsed = Number.parseInt(match[1], 10)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  const fallbackMatch = branch.match(/(\d+)/)
  if (fallbackMatch) {
    const parsed = Number.parseInt(fallbackMatch[1], 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

const FORCE_REVIEW_ACTIONS = new Set(['opened', 'ready_for_review', 'reopened'])

const shouldHandlePullRequestAction = (action?: string | null): boolean => {
  if (!action) {
    return false
  }
  return new Set([
    'opened',
    'ready_for_review',
    'synchronize',
    'reopened',
    'edited',
    'converted_to_draft',
    'review_requested',
    'review_request_removed',
  ]).has(action)
}

const shouldHandlePullRequestReviewAction = (action?: string | null): boolean => {
  if (!action) {
    return false
  }
  return new Set(['submitted', 'edited', 'dismissed']).has(action)
}

const buildReviewContextProto = (context: CodexTaskMessage['reviewContext'] | undefined) => {
  if (!context) {
    return undefined
  }

  return new GithubCodexReviewContext({
    summary: context.summary,
    reviewThreads: (context.reviewThreads ?? []).map(
      (thread) =>
        new GithubCodexReviewThread({
          summary: thread.summary,
          url: thread.url,
          author: thread.author,
        }),
    ),
    failingChecks: (context.failingChecks ?? []).map(
      (check) =>
        new GithubCodexFailingCheck({
          name: check.name,
          conclusion: check.conclusion,
          url: check.url,
          details: check.details,
        }),
    ),
    additionalNotes: context.additionalNotes ?? [],
  })
}

const toTimestamp = (value: string): Timestamp => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return Timestamp.fromDate(new Date())
  }
  return Timestamp.fromDate(date)
}

const toCodexTaskProto = (message: CodexTaskMessage, deliveryId: string): GithubCodexTaskMessage => {
  const protoStage =
    message.stage === 'planning'
      ? CodexTaskStage.PLANNING
      : message.stage === 'review'
        ? CodexTaskStage.REVIEW
        : CodexTaskStage.IMPLEMENTATION

  return new GithubCodexTaskMessage({
    stage: protoStage,
    prompt: message.prompt,
    repository: message.repository,
    base: message.base,
    head: message.head,
    issueNumber: BigInt(message.issueNumber),
    issueUrl: message.issueUrl,
    issueTitle: message.issueTitle,
    issueBody: message.issueBody,
    sender: message.sender,
    issuedAt: toTimestamp(message.issuedAt),
    planCommentId: message.planCommentId !== undefined ? BigInt(message.planCommentId) : undefined,
    planCommentUrl: message.planCommentUrl,
    planCommentBody: message.planCommentBody,
    deliveryId,
    reviewContext: buildReviewContextProto(message.reviewContext),
  })
}

export const createGithubWebhookHandler =
  ({ runtime, webhooks, config }: GithubWebhookDependencies) =>
  async (rawBody: string, request: Request): Promise<Response> => {
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

    const githubService = runtime.runSync(
      Effect.gen(function* (_) {
        return yield* GithubService
      }),
    )

    let parsedPayload: unknown
    try {
      parsedPayload = JSON.parse(rawBody) as unknown
    } catch (parseError) {
      logger.error({ err: parseError }, 'failed to parse github webhook payload')
      return new Response('Invalid JSON body', { status: 400 })
    }

    const eventName = request.headers.get('x-github-event') ?? 'unknown'
    const hookId = request.headers.get('x-github-hook-id') ?? 'unknown'
    const contentType = request.headers.get('content-type') ?? 'application/json'
    const actionValue =
      typeof (parsedPayload as { action?: unknown }).action === 'string'
        ? (parsedPayload as { action: string }).action
        : undefined

    const headers: Record<string, string> = {
      'x-github-delivery': deliveryId,
      'x-github-event': eventName,
      'x-github-hook-id': hookId,
      'content-type': contentType,
    }
    if (actionValue) {
      headers['x-github-action'] = actionValue
    }
    headers['x-hub-signature-256'] = signatureHeader

    let codexStageTriggered: string | null = null
    const senderLogin =
      typeof (parsedPayload as { sender?: { login?: unknown } }).sender?.login === 'string'
        ? (parsedPayload as { sender: { login: string } }).sender.login
        : undefined

    try {
      if (eventName === 'issues' && actionValue === 'opened' && isGithubIssueEvent(parsedPayload)) {
        const issue = parsedPayload.issue
        const repository = parsedPayload.repository
        const senderLoginValue = parsedPayload.sender?.login
        const issueNumber = issue?.number

        if (typeof issueNumber === 'number') {
          const issueAuthor = normalizeLogin(issue?.user?.login)

          if (issueAuthor === config.codexTriggerLogin) {
            const repositoryFullName = deriveRepositoryFullName(repository, issue?.repository_url)
            if (repositoryFullName) {
              const baseBranch = repository?.default_branch ?? config.codebase.baseBranch
              const headBranch = buildCodexBranchName(issueNumber, deliveryId, config.codebase.branchPrefix)
              const issueTitle =
                typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : `Issue #${issueNumber}`
              const issueBody = typeof issue?.body === 'string' ? issue.body : ''
              const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''
              const prompt = buildCodexPrompt({
                stage: 'planning',
                issueTitle,
                issueBody,
                repositoryFullName,
                issueNumber,
                baseBranch,
                headBranch,
                issueUrl,
              })

              const codexMessage: CodexTaskMessage = {
                stage: 'planning',
                prompt,
                repository: repositoryFullName,
                base: baseBranch,
                head: headBranch,
                issueNumber,
                issueUrl,
                issueTitle,
                issueBody,
                sender: typeof senderLoginValue === 'string' ? senderLoginValue : '',
                issuedAt: new Date().toISOString(),
              }

              await runtime.runPromise(
                publishKafkaMessage({
                  topic: config.topics.codex,
                  key: `issue-${issueNumber}-planning`,
                  value: JSON.stringify(codexMessage),
                  headers: { ...headers, 'x-codex-task-stage': 'planning' },
                }),
              )

              const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

              await runtime.runPromise(
                publishKafkaMessage({
                  topic: config.topics.codexStructured,
                  key: `issue-${issueNumber}-planning`,
                  value: codexStructuredMessage.toBinary(),
                  headers: {
                    ...headers,
                    'content-type': PROTO_CONTENT_TYPE,
                    'x-codex-task-stage': 'planning',
                    'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
                    'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
                  },
                }),
              )

              codexStageTriggered = 'planning'

              const reactionResult = await runtime.runPromise(
                githubService.postIssueReaction({
                  repositoryFullName,
                  issueNumber,
                  token: config.github.token,
                  reactionContent: config.github.ackReaction,
                  apiBaseUrl: config.github.apiBaseUrl,
                  userAgent: config.github.userAgent,
                }),
              )

              if (reactionResult.ok) {
                logger.info(
                  {
                    repository: repositoryFullName,
                    issueNumber,
                    deliveryId,
                    reaction: config.github.ackReaction,
                  },
                  'acknowledged github issue',
                )
              }
            }
          }
        }
      }

      if (eventName === 'issue_comment' && actionValue === 'created' && isGithubIssueCommentEvent(parsedPayload)) {
        const rawCommentBody = typeof parsedPayload.comment?.body === 'string' ? parsedPayload.comment.body : ''
        const trimmedCommentBody = rawCommentBody.trim()
        const senderLoginValue = parsedPayload.sender?.login
        const normalizedSender = normalizeLogin(senderLoginValue)
        const isAuthorizedSender = normalizedSender === config.codexTriggerLogin
        const isWorkflowSender = normalizedSender === config.codexWorkflowLogin
        const hasPlanMarker = rawCommentBody.includes(CODEX_PLAN_MARKER)
        const isManualTrigger = trimmedCommentBody === config.codexImplementationTriggerPhrase

        const shouldTriggerImplementation =
          (isAuthorizedSender && (isManualTrigger || hasPlanMarker)) || (hasPlanMarker && isWorkflowSender)

        if (shouldTriggerImplementation) {
          const issue = parsedPayload.issue
          const issueRepository = selectReactionRepository(issue, parsedPayload.repository)
          const repositoryFullName = deriveRepositoryFullName(issueRepository, issue?.repository_url)
          const issueNumber = typeof issue?.number === 'number' ? issue.number : undefined

          if (issueNumber && repositoryFullName) {
            const baseBranch = issueRepository?.default_branch ?? config.codebase.baseBranch
            const headBranch = buildCodexBranchName(issueNumber, deliveryId, config.codebase.branchPrefix)
            const issueTitle =
              typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : `Issue #${issueNumber}`
            const issueBody = typeof issue?.body === 'string' ? issue.body : ''
            const issueUrl = typeof issue?.html_url === 'string' ? issue.html_url : ''

            let planCommentBody: string | undefined
            let planCommentId: number | undefined
            let planCommentUrl: string | undefined

            if (hasPlanMarker) {
              planCommentBody = rawCommentBody
              planCommentId = typeof parsedPayload.comment?.id === 'number' ? parsedPayload.comment.id : undefined
              planCommentUrl =
                typeof parsedPayload.comment?.html_url === 'string' ? parsedPayload.comment.html_url : undefined
            } else {
              const planLookup = await runtime.runPromise(
                githubService.findLatestPlanComment({
                  repositoryFullName,
                  issueNumber,
                  token: config.github.token,
                  apiBaseUrl: config.github.apiBaseUrl,
                  userAgent: config.github.userAgent,
                }),
              )

              if (planLookup.ok) {
                planCommentBody = planLookup.comment.body
                planCommentId = planLookup.comment.id
                planCommentUrl = planLookup.comment.htmlUrl ?? undefined
              }
            }

            const prompt = buildCodexPrompt({
              stage: 'implementation',
              issueTitle,
              issueBody,
              repositoryFullName,
              issueNumber,
              baseBranch,
              headBranch,
              issueUrl,
              planCommentBody,
            })

            const codexMessage: CodexTaskMessage = {
              stage: 'implementation',
              prompt,
              repository: repositoryFullName,
              base: baseBranch,
              head: headBranch,
              issueNumber,
              issueUrl,
              issueTitle,
              issueBody,
              sender: typeof senderLoginValue === 'string' ? senderLoginValue : '',
              issuedAt: new Date().toISOString(),
              planCommentBody,
              planCommentId,
              planCommentUrl,
            }

            await runtime.runPromise(
              publishKafkaMessage({
                topic: config.topics.codex,
                key: `issue-${issueNumber}-implementation`,
                value: JSON.stringify(codexMessage),
                headers: { ...headers, 'x-codex-task-stage': 'implementation' },
              }),
            )

            const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

            await runtime.runPromise(
              publishKafkaMessage({
                topic: config.topics.codexStructured,
                key: `issue-${issueNumber}-implementation`,
                value: codexStructuredMessage.toBinary(),
                headers: {
                  ...headers,
                  'content-type': PROTO_CONTENT_TYPE,
                  'x-codex-task-stage': 'implementation',
                  'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
                  'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
                },
              }),
            )

            codexStageTriggered = 'implementation'
          }
        }
      }

      if (
        (eventName === 'pull_request' && shouldHandlePullRequestAction(actionValue)) ||
        (eventName === 'pull_request_review' && shouldHandlePullRequestReviewAction(actionValue))
      ) {
        const pullRequestPayload = (parsedPayload as { pull_request?: unknown }).pull_request
        if (pullRequestPayload && typeof pullRequestPayload === 'object') {
          let repositoryFullName = deriveRepositoryFullName(
            (parsedPayload as { repository?: GithubRepository | null | undefined }).repository,
            undefined,
          )

          if (!repositoryFullName) {
            const baseValue = (pullRequestPayload as { base?: unknown }).base
            if (baseValue && typeof baseValue === 'object') {
              const baseRepo = (baseValue as { repo?: unknown }).repo
              if (baseRepo && typeof baseRepo === 'object') {
                const fullNameValue = (baseRepo as { full_name?: unknown }).full_name
                if (typeof fullNameValue === 'string' && fullNameValue.length > 0) {
                  repositoryFullName = fullNameValue
                }
              }
            }
          }

          const pullNumber = toNumericId((pullRequestPayload as { number?: unknown }).number)

          const processPullRequest = async () => {
            if (!repositoryFullName || pullNumber === null) {
              return
            }

            const pullResult = await runtime.runPromise(
              githubService.fetchPullRequest({
                repositoryFullName,
                pullNumber,
                token: config.github.token,
                apiBaseUrl: config.github.apiBaseUrl,
                userAgent: config.github.userAgent,
              }),
            )

            if (!pullResult.ok) {
              logger.warn(
                {
                  deliveryId,
                  repository: repositoryFullName,
                  pullNumber,
                  reason: pullResult.reason,
                  status: pullResult.status,
                },
                'failed to fetch pull request metadata',
              )
              return
            }

            const pull = pullResult.pullRequest
            if (pull.state !== 'open' || pull.merged) {
              return
            }

            if (normalizeLogin(pull.authorLogin) !== config.codexTriggerLogin) {
              return
            }

            if (!pull.headRef || !pull.headSha || !pull.baseRef) {
              logger.warn(
                { deliveryId, repository: repositoryFullName, pullNumber },
                'missing pull request head information',
              )
              return
            }

            const issueNumber = parseIssueNumberFromBranch(pull.headRef, config.codebase.branchPrefix)
            if (issueNumber === null) {
              logger.warn(
                { deliveryId, repository: repositoryFullName, pullNumber, headRef: pull.headRef },
                'unable to extract issue number from codex branch',
              )
              return
            }

            const threadsResult = await runtime.runPromise(
              githubService.listPullRequestReviewThreads({
                repositoryFullName,
                pullNumber,
                token: config.github.token,
                apiBaseUrl: config.github.apiBaseUrl,
                userAgent: config.github.userAgent,
              }),
            )

            if (!threadsResult.ok) {
              logger.warn(
                {
                  deliveryId,
                  repository: repositoryFullName,
                  pullNumber,
                  reason: threadsResult.reason,
                  status: threadsResult.status,
                },
                'failed to load review threads',
              )
              return
            }

            const checksResult = await runtime.runPromise(
              githubService.listPullRequestCheckFailures({
                repositoryFullName,
                headSha: pull.headSha,
                token: config.github.token,
                apiBaseUrl: config.github.apiBaseUrl,
                userAgent: config.github.userAgent,
              }),
            )

            if (!checksResult.ok) {
              logger.warn(
                {
                  deliveryId,
                  repository: repositoryFullName,
                  pullNumber,
                  reason: checksResult.reason,
                  status: checksResult.status,
                },
                'failed to load check run failures',
              )
              return
            }

            const unresolvedThreads = threadsResult.threads
            const failingChecks = checksResult.checks
            const outstandingWork = unresolvedThreads.length > 0 || failingChecks.length > 0
            const shouldForceReviewStage =
              eventName === 'pull_request' && actionValue ? FORCE_REVIEW_ACTIONS.has(actionValue) : false

            if (pull.draft && !outstandingWork) {
              const undraftResult = await runtime.runPromise(
                githubService.markPullRequestReadyForReview({
                  repositoryFullName,
                  pullNumber,
                  token: config.github.token,
                  apiBaseUrl: config.github.apiBaseUrl,
                  userAgent: config.github.userAgent,
                }),
              )

              if (undraftResult.ok) {
                logger.info(
                  { deliveryId, repository: repositoryFullName, pullNumber },
                  'marking codex pull request ready for review',
                )

                const commentResult = await runtime.runPromise(
                  githubService.createPullRequestComment({
                    repositoryFullName,
                    pullNumber,
                    body: CODEX_REVIEW_COMMENT,
                    token: config.github.token,
                    apiBaseUrl: config.github.apiBaseUrl,
                    userAgent: config.github.userAgent,
                  }),
                )

                if (!commentResult.ok) {
                  logger.warn(
                    {
                      deliveryId,
                      repository: repositoryFullName,
                      pullNumber,
                      reason: commentResult.reason,
                      status: commentResult.status,
                    },
                    'failed to post codex review handoff comment',
                  )
                }
              } else {
                logger.warn(
                  {
                    deliveryId,
                    repository: repositoryFullName,
                    pullNumber,
                    reason: undraftResult.reason,
                    status: undraftResult.status,
                  },
                  'failed to convert codex pull request to ready state',
                )
              }

              return
            }

            if (!outstandingWork && !shouldForceReviewStage) {
              return
            }

            const summaryParts: string[] = []
            if (unresolvedThreads.length > 0) {
              summaryParts.push(
                `${unresolvedThreads.length} unresolved review thread${unresolvedThreads.length === 1 ? '' : 's'}`,
              )
            }
            if (failingChecks.length > 0) {
              summaryParts.push(`${failingChecks.length} failing check${failingChecks.length === 1 ? '' : 's'}`)
            }

            const additionalNotes: string[] = []
            const mergeableState = pull.mergeableState ?? undefined
            if (mergeableState && !['clean', 'unstable', 'unknown'].includes(mergeableState)) {
              additionalNotes.push(`GitHub reports mergeable_state=${mergeableState}.`)
            }

            const reviewContext: CodexTaskMessage['reviewContext'] = {
              summary: summaryParts.length > 0 ? `Outstanding items: ${summaryParts.join(', ')}.` : undefined,
              reviewThreads: unresolvedThreads.map((thread) => ({
                summary: thread.summary,
                url: thread.url,
                author: thread.author,
              })),
              failingChecks: failingChecks.map((check) => ({
                name: check.name,
                conclusion: check.conclusion,
                url: check.url,
                details: check.details,
              })),
              additionalNotes: additionalNotes.length > 0 ? additionalNotes : undefined,
            }

            const prompt = buildCodexPrompt({
              stage: 'review',
              issueTitle: pull.title,
              issueBody: pull.body,
              repositoryFullName,
              issueNumber,
              baseBranch: pull.baseRef,
              headBranch: pull.headRef,
              issueUrl: pull.htmlUrl,
              reviewContext,
            })

            const codexMessage: CodexTaskMessage = {
              stage: 'review',
              prompt,
              repository: repositoryFullName,
              base: pull.baseRef,
              head: pull.headRef,
              issueNumber,
              issueUrl: pull.htmlUrl,
              issueTitle: pull.title,
              issueBody: pull.body,
              sender: typeof senderLogin === 'string' ? senderLogin : '',
              issuedAt: new Date().toISOString(),
              reviewContext,
            }

            await runtime.runPromise(
              publishKafkaMessage({
                topic: config.topics.codex,
                key: `pull-${pull.number}-review`,
                value: JSON.stringify(codexMessage),
                headers: { ...headers, 'x-codex-task-stage': 'review' },
              }),
            )

            const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

            await runtime.runPromise(
              publishKafkaMessage({
                topic: config.topics.codexStructured,
                key: `pull-${pull.number}-review`,
                value: codexStructuredMessage.toBinary(),
                headers: {
                  ...headers,
                  'content-type': PROTO_CONTENT_TYPE,
                  'x-codex-task-stage': 'review',
                  'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
                  'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
                },
              }),
            )

            codexStageTriggered = 'review'
          }

          await processPullRequest()
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
      logger.error({ err: error, deliveryId, eventName }, 'failed to enqueue github webhook event')
      return new Response('Failed to enqueue webhook event', { status: 500 })
    }
  }
