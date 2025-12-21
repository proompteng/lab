import type { ReadyCommentCommand } from '@/codex/workflow-machine'
import { deriveRepositoryFullName, type GithubRepository } from '@/github-payload'
import { logger } from '@/logger'
import { CODEX_READY_COMMENT_MARKER, CODEX_READY_TO_MERGE_COMMENT } from '../constants'
import { shouldHandlePullRequestAction } from '../helpers'
import type { WebhookConfig } from '../types'
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
  const { parsedPayload, config, executionContext, actionValue, skipActionCheck } = params

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
      return null
    }

    const checksResult = await executionContext.runGithub(() =>
      executionContext.githubService.listPullRequestCheckFailures({
        repositoryFullName: repoFullName,
        headSha: pull.headSha,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!checksResult.ok) {
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
        'failed to read pull request reactions; ready comment will not be posted',
      )
    }

    const unresolvedThreads = threadsResult.threads
    const failingChecks = checksResult.checks
    const mergeableState = pull.mergeableState ? pull.mergeableState.toLowerCase() : null
    const mergeStateRequiresAttention = mergeableState
      ? !['clean', 'unstable', 'unknown'].includes(mergeableState)
      : false
    const hasMergeConflicts = mergeableState === 'dirty'
    const outstandingWork = unresolvedThreads.length > 0 || failingChecks.length > 0 || hasMergeConflicts

    const readyCommentCandidate: ReadyCommentCommand | undefined =
      hasThumbsUpReaction && !mergeStateRequiresAttention && !outstandingWork && !pull.draft
        ? {
            repositoryFullName: repoFullName,
            pullNumber,
            issueNumber: pull.number,
            body:
              executionContext.workflowIdentifier && executionContext.workflowIdentifier.length > 0
                ? `${CODEX_READY_TO_MERGE_COMMENT}\n_Workflow: ${executionContext.workflowIdentifier}_`
                : CODEX_READY_TO_MERGE_COMMENT,
            marker: CODEX_READY_COMMENT_MARKER,
          }
        : undefined

    if (!readyCommentCandidate) {
      return null
    }

    logger.info({ repository: repoFullName, pullNumber }, 'prepared codex ready comment')
    const { stage } = await executeWorkflowCommands(
      [{ type: 'postReadyComment', data: readyCommentCandidate }],
      executionContext,
    )
    return stage ?? null
  }

  return processPullRequest()
}
