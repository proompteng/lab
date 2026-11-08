import { Schema } from 'effect'
import type { ReadyApprovalCommand } from '@/codex/workflow-machine'
import { deriveRepositoryFullName, type GithubRepository } from '@/github-payload'
import { logger } from '@/logger'
import type { WebhookConfig } from '../../types'
import { CODEX_READY_TO_MERGE_COMMENT } from '../constants'
import { shouldHandlePullRequestAction } from '../helpers'
import type { WorkflowExecutionContext, WorkflowStage } from '../workflow'
import { executeWorkflowCommands } from '../workflow'

interface PullRequestBaseParams {
  parsedPayload: unknown
  headers: Record<string, string>
  config: WebhookConfig
  executionContext: WorkflowExecutionContext
  deliveryId: string
  actionValue?: string | null
  senderLogin?: string
  skipActionCheck?: boolean
}

export const handlePullRequestEvent = async (params: PullRequestBaseParams): Promise<WorkflowStage | null> => {
  const { parsedPayload, config, executionContext, actionValue, skipActionCheck, deliveryId } = params

  if (!skipActionCheck && !shouldHandlePullRequestAction(actionValue)) {
    return null
  }

  const pullRequestPayload = (parsedPayload as { pull_request?: unknown }).pull_request
  if (!pullRequestPayload || typeof pullRequestPayload !== 'object') {
    return null
  }

  let repositoryFullNameCandidate = deriveRepositoryFullName(
    (parsedPayload as { repository?: GithubRepository | null | undefined }).repository,
    undefined,
  )

  if (!repositoryFullNameCandidate) {
    const baseValue = (pullRequestPayload as { base?: unknown }).base
    if (baseValue && typeof baseValue === 'object') {
      const baseRepo = (baseValue as { repo?: unknown }).repo
      if (baseRepo && typeof baseRepo === 'object') {
        const fullNameValue = (baseRepo as { full_name?: unknown }).full_name
        if (typeof fullNameValue === 'string' && fullNameValue.length > 0) {
          repositoryFullNameCandidate = fullNameValue
        }
      }
    }
  }

  const repoFullName = repositoryFullNameCandidate
  const pullNumber = (pullRequestPayload as { number?: unknown }).number
  if (!repoFullName || typeof pullNumber !== 'number') {
    return null
  }

  const processPullRequest = async () => {
    const logReadFailure = (stage: string, result: { reason: string; status?: number }) =>
      logger.warn(
        { repository: repoFullName, pullNumber, deliveryId, stage, reason: result.reason, status: result.status },
        'ready approval blocked by GitHub read failure',
      )
    logger.info({ repository: repoFullName, pullNumber, action: actionValue ?? 'unknown' }, 'processing pull request')
    const pullResult = await executionContext.runGithub(() =>
      executionContext.githubService.fetchPullRequest({
        repositoryFullName: repoFullName,
        pullNumber,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!pullResult.ok) {
      logReadFailure('pull-request', pullResult)
      return null
    }

    const pull = pullResult.pullRequest
    if (pull.state !== 'open' || pull.merged) {
      logger.info(
        { repository: repoFullName, pullNumber, state: pull.state, merged: pull.merged },
        'ignoring closed pull request',
      )
      return null
    }

    if (!pull.headRef || !pull.headSha || !pull.baseRef) {
      logger.warn(
        { repository: repoFullName, pullNumber, deliveryId },
        'ready approval blocked by missing pull request refs',
      )
      return null
    }

    const threadsResult = await executionContext.runGithub(() =>
      executionContext.githubService.listPullRequestReviewThreads({
        repositoryFullName: repoFullName,
        pullNumber,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!threadsResult.ok) {
      logReadFailure('review-threads', threadsResult)
      return null
    }

    const checksResult = await executionContext.runGithub(() =>
      executionContext.githubService.listPullRequestBlockingChecks({
        repositoryFullName: repoFullName,
        headSha: pull.headSha,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!checksResult.ok) {
      logReadFailure('checks', checksResult)
      return null
    }

    const reactionsResult = await executionContext.runGithub(() =>
      executionContext.githubService.issueHasReaction({
        repositoryFullName: repoFullName,
        issueNumber: pull.number,
        reactionContent: '+1',
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    const hasThumbsUpReaction = reactionsResult.ok ? reactionsResult.hasReaction : false
    if (!reactionsResult.ok) {
      logger.warn(
        {
          repository: repoFullName,
          pullNumber,
          reason: reactionsResult.reason,
          status: reactionsResult.status,
        },
        'failed to read pull request reactions; ready approval will not be posted',
      )
    }

    const unresolvedThreads = threadsResult.threads
    const blockingChecks = checksResult.checks
    const mergeableState = pull.mergeableState ? pull.mergeableState.toLowerCase() : null
    // GitHub also reports 'blocked' when this approval is the missing requirement.
    const mergeStateRequiresAttention = mergeableState
      ? !['clean', 'unstable', 'blocked', 'unknown'].includes(mergeableState)
      : false
    const hasMergeConflicts = mergeableState === 'dirty'
    const outstandingWork = unresolvedThreads.length > 0 || blockingChecks.length > 0 || hasMergeConflicts

    const readyApproval: ReadyApprovalCommand | undefined =
      hasThumbsUpReaction && !mergeStateRequiresAttention && !outstandingWork && !pull.draft
        ? {
            repositoryFullName: repoFullName,
            pullNumber,
            headSha: pull.headSha,
            body: CODEX_READY_TO_MERGE_COMMENT,
          }
        : undefined

    if (!readyApproval) {
      logger.info(
        {
          repository: repoFullName,
          pullNumber,
          headSha: pull.headSha,
          deliveryId,
          blockingChecks: blockingChecks.map(({ name, conclusion }) => ({ name, conclusion })),
          unresolvedThreadCount: unresolvedThreads.length,
          hasThumbsUpReaction,
          draft: pull.draft,
          mergeableState,
        },
        'ready approval blocked',
      )
      return null
    }

    logger.info({ repository: repoFullName, pullNumber }, 'prepared codex ready approval')
    const { stage } = await executeWorkflowCommands(
      [{ type: 'approveReadyPullRequest', data: readyApproval }],
      executionContext,
    )
    return stage ?? null
  }

  return processPullRequest()
}

const ReadinessEventSchema = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  issue: Schema.optional(Schema.Struct({ number: Schema.Number, pull_request: Schema.optional(Schema.Unknown) })),
  pull_request: Schema.optional(Schema.Struct({ number: Schema.Number })),
  comment: Schema.optional(Schema.Struct({ user: Schema.Struct({ login: Schema.String }) })),
  check_run: Schema.optional(Schema.Struct({ head_sha: Schema.String })),
  check_suite: Schema.optional(Schema.Struct({ head_sha: Schema.String })),
  sha: Schema.optional(Schema.String),
})

export const handleReadinessEvent = async (params: PullRequestBaseParams & { eventName: string }): Promise<void> => {
  const { eventName, actionValue } = params
  const isCheck = (eventName === 'check_run' || eventName === 'check_suite') && actionValue === 'completed'
  const isStatus = eventName === 'status'
  const isComment = eventName === 'issue_comment' && (actionValue === 'created' || actionValue === 'edited')
  const isReview = eventName === 'pull_request_review' && ['submitted', 'dismissed'].includes(actionValue ?? '')
  const isThread = eventName === 'pull_request_review_thread' && actionValue === 'resolved'
  if (!isCheck && !isStatus && !isComment && !isReview && !isThread) return
  const decoded = Schema.decodeUnknownResult(ReadinessEventSchema)(params.parsedPayload)
  if (decoded._tag === 'Failure') return
  const payload = decoded.success
  if (
    isComment &&
    (payload.issue?.pull_request === undefined || payload.comment?.user.login !== 'chatgpt-codex-connector[bot]')
  )
    return
  let pullNumbers: readonly number[]
  if (isCheck || isStatus) {
    const headSha = payload.check_run?.head_sha ?? payload.check_suite?.head_sha ?? payload.sha
    if (!headSha) return
    const result = await params.executionContext.runGithub(() =>
      params.executionContext.githubService.listCommitPullRequests({
        repositoryFullName: payload.repository.full_name,
        headSha,
        token: params.config.github.token,
        apiBaseUrl: params.config.github.apiBaseUrl,
        userAgent: params.config.github.userAgent,
      }),
    )
    if (!result.ok) throw new Error(`Could not resolve pull requests for completed checks: ${result.reason}`)
    pullNumbers = result.pullNumbers
  } else {
    const number = isComment ? payload.issue?.number : payload.pull_request?.number
    pullNumbers = number === undefined ? [] : [number]
  }
  for (const number of new Set(pullNumbers)) {
    await handlePullRequestEvent({
      ...params,
      skipActionCheck: true,
      parsedPayload: { repository: payload.repository, pull_request: { number } },
    })
  }
}
