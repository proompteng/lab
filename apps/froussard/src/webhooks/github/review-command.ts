import { buildCodexPrompt, type CodexTaskMessage } from '@/codex'
import type { ReviewCommand } from '@/codex/workflow-machine'
import type { PullRequestCheckFailure, PullRequestReviewThread, PullRequestSummary } from '@/services/github/types'
import { PROTO_CODEX_TASK_FULL_NAME, PROTO_CODEX_TASK_SCHEMA, PROTO_CONTENT_TYPE } from './constants'
import { toCodexTaskProto } from './payloads'
import { buildReviewFingerprint } from './review-fingerprint'
import type { WebhookConfig } from './types'

const buildReviewHeaders = (headers: Record<string, string>, extras: { fingerprint: string; headSha: string }) => ({
  json: {
    ...headers,
    'x-codex-task-stage': 'review',
    'x-codex-review-fingerprint': extras.fingerprint,
    'x-codex-review-head-sha': extras.headSha,
  },
  structured: {
    ...headers,
    'x-codex-task-stage': 'review',
    'x-codex-review-fingerprint': extras.fingerprint,
    'x-codex-review-head-sha': extras.headSha,
    'content-type': PROTO_CONTENT_TYPE,
    'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
    'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
  },
})

export interface BuildReviewCommandOptions {
  config: Pick<WebhookConfig, 'topics'>
  deliveryId: string
  headers: Record<string, string>
  issueNumber: number
  pull: PullRequestSummary & { repositoryFullName: string }
  reviewThreads: PullRequestReviewThread[]
  failingChecks: PullRequestCheckFailure[]
  forceReview: boolean
  senderLogin?: string
}

export interface BuildReviewCommandResult {
  reviewCommand: ReviewCommand
  reviewContext: CodexTaskMessage['reviewContext']
  fingerprint: string
  outstandingWork: boolean
  mergeStateRequiresAttention: boolean
  mergeState: string | null
  hasMergeConflicts: boolean
}

export const buildReviewCommand = (options: BuildReviewCommandOptions): BuildReviewCommandResult => {
  const { config, deliveryId, headers, issueNumber, pull, reviewThreads, failingChecks, forceReview, senderLogin } =
    options

  const mergeableState = pull.mergeableState ? pull.mergeableState.toLowerCase() : null
  const mergeStateRequiresAttention = mergeableState
    ? !['clean', 'unstable', 'unknown'].includes(mergeableState)
    : false
  const hasMergeConflicts = mergeableState === 'dirty'
  const outstandingWork = reviewThreads.length > 0 || failingChecks.length > 0 || hasMergeConflicts

  const summaryParts: string[] = []
  if (reviewThreads.length > 0) {
    summaryParts.push(`${reviewThreads.length} unresolved review thread${reviewThreads.length === 1 ? '' : 's'}`)
  }
  if (failingChecks.length > 0) {
    summaryParts.push(`${failingChecks.length} failing check${failingChecks.length === 1 ? '' : 's'}`)
  }
  if (hasMergeConflicts) {
    summaryParts.push('merge conflicts detected')
  }

  const additionalNotes: string[] = []
  if (mergeStateRequiresAttention && mergeableState) {
    additionalNotes.push(`GitHub reports mergeable_state=${mergeableState}.`)
    if (hasMergeConflicts) {
      additionalNotes.push('Resolve merge conflicts with the base branch before retrying.')
    }
  }

  const reviewContext: CodexTaskMessage['reviewContext'] = {
    summary: summaryParts.length > 0 ? `Outstanding items: ${summaryParts.join(', ')}.` : undefined,
    reviewThreads: reviewThreads.map((thread) => ({
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
    repositoryFullName: pull.repositoryFullName,
    issueNumber,
    baseBranch: pull.baseRef,
    headBranch: pull.headRef,
    issueUrl: pull.htmlUrl,
    reviewContext,
  })

  const codexMessage: CodexTaskMessage = {
    stage: 'review',
    prompt,
    repository: pull.repositoryFullName,
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

  const structuredMessage = toCodexTaskProto(codexMessage, deliveryId)

  const fingerprint = buildReviewFingerprint({
    headSha: pull.headSha,
    outstandingWork,
    forceReview,
    mergeStateRequiresAttention,
    mergeState: mergeableState,
    hasMergeConflicts,
    reviewThreads,
    failingChecks,
  })

  const reviewHeaders = buildReviewHeaders(headers, {
    fingerprint,
    headSha: pull.headSha,
  })

  const reviewCommand: ReviewCommand = {
    stage: 'review',
    key: `pull-${pull.number}-review-${fingerprint}`,
    codexMessage,
    structuredMessage,
    topics: {
      codex: config.topics.codex,
      codexStructured: config.topics.codexStructured,
    },
    jsonHeaders: reviewHeaders.json,
    structuredHeaders: reviewHeaders.structured,
  }

  return {
    reviewCommand,
    reviewContext,
    fingerprint,
    outstandingWork,
    mergeStateRequiresAttention,
    mergeState: mergeableState,
    hasMergeConflicts,
  }
}
