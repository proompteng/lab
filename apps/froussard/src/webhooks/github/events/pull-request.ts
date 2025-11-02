import { normalizeLogin } from '@/codex'
import type {
  ReadyCommentCommand as ReadyCommentCommandType,
  ReviewEvaluation,
  UndraftCommand,
} from '@/codex/workflow-machine'
import { evaluateCodexWorkflow, shouldPostReadyCommentGuard, shouldUndraftGuard } from '@/codex/workflow-machine'
import { deriveRepositoryFullName, type GithubRepository } from '@/github-payload'
import { logger } from '@/logger'
import { CODEX_READY_COMMENT_MARKER, CODEX_READY_TO_MERGE_COMMENT, CODEX_REVIEW_COMMENT } from '../constants'
import {
  FORCE_REVIEW_ACTIONS,
  parseIssueNumberFromBranch,
  shouldHandlePullRequestAction,
  shouldHandlePullRequestReviewAction,
} from '../helpers'
import { buildReviewCommand } from '../review-command'
import {
  buildPullReviewFingerprintKey,
  forgetReviewFingerprint,
  rememberReviewFingerprint,
} from '../review-fingerprint'
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
  const { parsedPayload, headers, config, executionContext, deliveryId, actionValue, senderLogin, skipActionCheck } =
    params

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

    if (normalizeLogin(pull.authorLogin) !== config.codexTriggerLogin) {
      return null
    }

    if (!pull.headRef || !pull.headSha || !pull.baseRef) {
      return null
    }

    const issueNumber = parseIssueNumberFromBranch(pull.headRef, config.codebase.branchPrefix)
    if (issueNumber === null) {
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
    const shouldForceReviewStage = actionValue ? FORCE_REVIEW_ACTIONS.has(actionValue) : false

    const reviewArtifacts = buildReviewCommand({
      config,
      deliveryId,
      headers,
      issueNumber,
      pull: { ...pull, repositoryFullName: repoFullName },
      reviewThreads: unresolvedThreads,
      failingChecks,
      forceReview: shouldForceReviewStage,
      senderLogin,
    })

    const fingerprintKey = buildPullReviewFingerprintKey(repoFullName, pull.number)
    const fingerprintChanged = rememberReviewFingerprint(fingerprintKey, reviewArtifacts.fingerprint)

    const reviewEvaluation: ReviewEvaluation = {
      outstandingWork: reviewArtifacts.outstandingWork,
      forceReview: shouldForceReviewStage,
      isDraft: pull.draft,
      mergeStateRequiresAttention: reviewArtifacts.mergeStateRequiresAttention,
      reviewCommand: undefined,
      undraftCommand: undefined,
      readyCommentCommand: undefined,
    }

    const undraftCandidate: UndraftCommand | undefined =
      pull.draft && actionValue !== 'converted_to_draft'
        ? {
            repositoryFullName: repoFullName,
            pullNumber,
            commentBody: CODEX_REVIEW_COMMENT,
          }
        : undefined

    if (
      undraftCandidate &&
      shouldUndraftGuard(
        { commands: [] },
        { type: 'PR_ACTIVITY', data: { ...reviewEvaluation, undraftCommand: undraftCandidate } },
      )
    ) {
      reviewEvaluation.undraftCommand = undraftCandidate
      logger.info({ repository: repoFullName, pullNumber }, 'prepared codex undraft command')
    }

    const readyCommentCandidate: ReadyCommentCommandType | undefined =
      hasThumbsUpReaction &&
      !reviewArtifacts.mergeStateRequiresAttention &&
      !shouldForceReviewStage &&
      !reviewArtifacts.outstandingWork
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

    if (
      readyCommentCandidate &&
      shouldPostReadyCommentGuard(
        { commands: [] },
        { type: 'PR_ACTIVITY', data: { ...reviewEvaluation, readyCommentCommand: readyCommentCandidate } },
      )
    ) {
      reviewEvaluation.readyCommentCommand = readyCommentCandidate
      logger.info({ repository: repoFullName, pullNumber }, 'prepared codex ready comment')
    }

    const evaluation = evaluateCodexWorkflow({
      type: 'PR_ACTIVITY',
      data: reviewEvaluation,
    })

    try {
      const { stage } = await executeWorkflowCommands(evaluation.commands, executionContext)
      return stage ?? null
    } catch (error) {
      if (fingerprintChanged) {
        forgetReviewFingerprint(fingerprintKey, reviewArtifacts.fingerprint)
      }
      throw error
    }
  }

  return processPullRequest()
}

export const handlePullRequestReviewEvent = async (params: PullRequestBaseParams): Promise<WorkflowStage | null> => {
  const { parsedPayload, headers, config, executionContext, deliveryId, actionValue, senderLogin } = params

  if (!shouldHandlePullRequestReviewAction(actionValue)) {
    return null
  }

  return handlePullRequestEvent({
    parsedPayload,
    headers,
    config,
    executionContext,
    deliveryId,
    actionValue,
    senderLogin,
    skipActionCheck: true,
  })
}
