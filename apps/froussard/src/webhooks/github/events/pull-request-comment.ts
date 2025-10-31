import { Schema } from 'effect'

import { evaluateCodexWorkflow } from '@/codex/workflow-machine'
import { deriveRepositoryFullName, isGithubIssueCommentEvent } from '@/github-payload'
import { logger } from '@/logger'

import { parseIssueNumberFromBranch } from '../helpers'
import { buildReviewCommand } from '../review-command'
import {
  buildCommentReviewFingerprintKey,
  forgetReviewFingerprint,
  rememberReviewFingerprint,
} from '../review-fingerprint'
import type { WorkflowStage } from '../workflow'
import { executeWorkflowCommands } from '../workflow'
import type { BaseIssueParams, IssueCommentPayload } from './issues'
import { IssueCommentPayloadSchema } from './issues'

const REVIEW_TRIGGER_PATTERN = /(?:^|\s)@tuslagch\s+review(?:\b|[.!?]|$)/i
const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

interface ReviewCommentParams extends BaseIssueParams {
  actionValue?: string
}

interface ReviewCommentResult {
  handled: boolean
  stage: WorkflowStage | null
}

const containsReviewTrigger = (body: string) => REVIEW_TRIGGER_PATTERN.test(body)

const isAuthorizedCommenter = (association?: string | null) =>
  AUTHORIZED_ASSOCIATIONS.has((association ?? '').toUpperCase())

export const handleReviewComment = async (params: ReviewCommentParams): Promise<ReviewCommentResult> => {
  const { parsedPayload, headers, config, executionContext, deliveryId, senderLogin, actionValue } = params

  if (actionValue !== 'created' && actionValue !== 'edited') {
    return { handled: false, stage: null }
  }

  if (!isGithubIssueCommentEvent(parsedPayload)) {
    return { handled: false, stage: null }
  }

  let payload: IssueCommentPayload
  try {
    payload = Schema.decodeUnknownSync(IssueCommentPayloadSchema)(parsedPayload)
  } catch {
    return { handled: false, stage: null }
  }

  if (!payload.issue?.pull_request) {
    return { handled: false, stage: null }
  }

  const commentBody = typeof payload.comment?.body === 'string' ? payload.comment.body : ''
  if (!containsReviewTrigger(commentBody)) {
    return { handled: false, stage: null }
  }

  const authorAssociation = payload.comment?.author_association ?? ''
  if (!isAuthorizedCommenter(authorAssociation)) {
    logger.info(
      {
        action: actionValue,
        repository: payload.repository?.full_name ?? payload.issue?.repository_url ?? 'unknown',
        commentId: payload.comment?.id ?? null,
        association: authorAssociation,
      },
      'ignoring @tuslagch review comment from unauthorized author',
    )
    return { handled: false, stage: null }
  }

  const repositoryFullName = deriveRepositoryFullName(payload.repository, payload.issue?.repository_url)
  const pullNumber = payload.issue?.number
  const commentId = payload.comment?.id
  const updatedAt = payload.comment?.updated_at

  if (!repositoryFullName || typeof pullNumber !== 'number' || typeof commentId !== 'number' || !updatedAt) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName ?? payload.issue?.repository_url ?? 'unknown',
        pullNumber,
        commentId,
        updatedAt,
      },
      'insufficient data to process @tuslagch review comment; falling back to default handler',
    )
    return { handled: false, stage: null }
  }

  logger.info(
    {
      action: actionValue,
      repository: repositoryFullName,
      pullNumber,
      commentId,
    },
    'processing @tuslagch review comment',
  )

  const pullResult = await executionContext.runGithub(() =>
    executionContext.githubService.fetchPullRequest({
      repositoryFullName,
      pullNumber,
      token: config.github.token,
      apiBaseUrl: config.github.apiBaseUrl,
      userAgent: config.github.userAgent,
    }),
  )

  logger.info(
    {
      action: actionValue,
      repository: repositoryFullName,
      pullNumber,
      pullResultOk: pullResult.ok,
      reason: pullResult.ok ? null : pullResult.reason,
    },
    'review comment: pull request fetch result',
  )

  if (!pullResult.ok) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        reason: pullResult.reason,
      },
      'failed to load pull request for @tuslagch review comment',
    )
    return { handled: true, stage: null }
  }

  const pull = pullResult.pullRequest
  if (pull.state !== 'open' || pull.merged) {
    logger.info(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        state: pull.state,
        merged: pull.merged,
      },
      'ignoring @tuslagch review comment for closed pull request',
    )
    return { handled: true, stage: null }
  }

  if (!pull.headRef) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
      },
      'failed to derive codex issue number for @tuslagch review comment: missing head ref',
    )
    return { handled: true, stage: null }
  }

  if (!pull.headSha || !pull.baseRef) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        headSha: pull.headSha ?? null,
        baseRef: pull.baseRef ?? null,
      },
      'failed to process @tuslagch review comment: missing head sha or base ref',
    )
    return { handled: true, stage: null }
  }

  const issueNumber = parseIssueNumberFromBranch(pull.headRef, config.codebase.branchPrefix)
  if (issueNumber === null) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        headRef: pull.headRef,
        branchPrefix: config.codebase.branchPrefix,
      },
      'failed to derive codex issue number for @tuslagch review comment',
    )
    return { handled: true, stage: null }
  }

  const threadsResult = await executionContext.runGithub(() =>
    executionContext.githubService.listPullRequestReviewThreads({
      repositoryFullName,
      pullNumber,
      token: config.github.token,
      apiBaseUrl: config.github.apiBaseUrl,
      userAgent: config.github.userAgent,
    }),
  )

  logger.info(
    {
      action: actionValue,
      repository: repositoryFullName,
      pullNumber,
      threadsResultOk: threadsResult.ok,
      reason: threadsResult.ok ? null : threadsResult.reason,
    },
    'review comment: review threads fetch result',
  )

  if (!threadsResult.ok) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        reason: threadsResult.reason,
      },
      'failed to load review threads for @tuslagch review comment',
    )
    return { handled: true, stage: null }
  }

  const checksResult = await executionContext.runGithub(() =>
    executionContext.githubService.listPullRequestCheckFailures({
      repositoryFullName,
      headSha: pull.headSha,
      token: config.github.token,
      apiBaseUrl: config.github.apiBaseUrl,
      userAgent: config.github.userAgent,
    }),
  )

  logger.info(
    {
      action: actionValue,
      repository: repositoryFullName,
      pullNumber,
      checksResultOk: checksResult.ok,
      reason: checksResult.ok ? null : checksResult.reason,
    },
    'review comment: check failures fetch result',
  )

  if (!checksResult.ok) {
    logger.warn(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        reason: checksResult.reason,
      },
      'failed to load check failures for @tuslagch review comment',
    )
    return { handled: true, stage: null }
  }

  const reviewArtifacts = buildReviewCommand({
    config,
    deliveryId,
    headers,
    issueNumber,
    pull: { ...pull, repositoryFullName },
    reviewThreads: threadsResult.threads,
    failingChecks: checksResult.checks,
    forceReview: false,
    senderLogin,
  })

  const fingerprintKey = buildCommentReviewFingerprintKey(repositoryFullName, pull.number, commentId, updatedAt)
  const fingerprintChanged = rememberReviewFingerprint(fingerprintKey, reviewArtifacts.fingerprint)

  if (!fingerprintChanged) {
    logger.info(
      {
        action: actionValue,
        repository: repositoryFullName,
        pullNumber,
        commentId,
        fingerprint: reviewArtifacts.fingerprint,
      },
      'skipping duplicate codex review request from @tuslagch comment',
    )
    return { handled: true, stage: null }
  }

  try {
    const evaluation = evaluateCodexWorkflow({
      type: 'REVIEW_REQUESTED',
      data: {
        reviewCommand: reviewArtifacts.reviewCommand,
        outstandingWork: reviewArtifacts.outstandingWork,
      },
    })

    const { stage } = await executeWorkflowCommands(evaluation.commands, executionContext)
    return { handled: true, stage: stage ?? null }
  } catch (error) {
    forgetReviewFingerprint(fingerprintKey, reviewArtifacts.fingerprint)
    throw error
  }
}
