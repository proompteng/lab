import { buildCodexPrompt, type CodexTaskMessage } from '@/codex'
import {
  evaluateCodexWorkflow,
  type ReadyCommentCommand,
  type ReviewEvaluation,
  shouldPostReadyCommentGuard,
  shouldRequestReviewGuard,
  shouldUndraftGuard,
  type UndraftCommand,
} from '@/codex/workflow-machine'
import { deriveRepositoryFullName, type GithubRepository } from '@/github-payload'
import { normalizeLogin } from '@/codex'
import type { WorkflowExecutionContext, WorkflowStage } from '../workflow'
import { executeWorkflowCommands } from '../workflow'
import type { WebhookConfig } from '../types'
import {
  CODEX_READY_COMMENT_MARKER,
  CODEX_READY_TO_MERGE_COMMENT,
  PROTO_CODEX_TASK_FULL_NAME,
  PROTO_CODEX_TASK_SCHEMA,
  PROTO_CONTENT_TYPE,
  CODEX_REVIEW_COMMENT,
} from '../constants'
import { toCodexTaskProto } from '../payloads'
import {
  FORCE_REVIEW_ACTIONS,
  parseIssueNumberFromBranch,
  shouldHandlePullRequestAction,
  shouldHandlePullRequestReviewAction,
} from '../helpers'
import type { ReadyCommentCommand as ReadyCommentCommandType } from '@/codex/workflow-machine'

interface PullRequestBaseParams {
  parsedPayload: Record<string, any>
  headers: Record<string, string>
  config: WebhookConfig
  executionContext: WorkflowExecutionContext
  deliveryId: string
  actionValue?: string | null
  senderLogin?: string
  skipActionCheck?: boolean
}

const buildReviewHeaders = (headers: Record<string, string>) => ({
  json: {
    ...headers,
    'x-codex-task-stage': 'review',
  },
  structured: {
    ...headers,
    'x-codex-task-stage': 'review',
    'content-type': PROTO_CONTENT_TYPE,
    'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
    'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
  },
})

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

  const pullNumber = (pullRequestPayload as { number?: unknown }).number
  if (!repositoryFullName || typeof pullNumber !== 'number') {
    return null
  }

  const processPullRequest = async () => {
    const pullResult = await executionContext.runtime.runPromise(
      executionContext.githubService.fetchPullRequest({
        repositoryFullName: repositoryFullName!,
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

    const threadsResult = await executionContext.runtime.runPromise(
      executionContext.githubService.listPullRequestReviewThreads({
        repositoryFullName: repositoryFullName!,
        pullNumber,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!threadsResult.ok) {
      return null
    }

    const checksResult = await executionContext.runtime.runPromise(
      executionContext.githubService.listPullRequestCheckFailures({
        repositoryFullName: repositoryFullName!,
        headSha: pull.headSha,
        token: config.github.token,
        apiBaseUrl: config.github.apiBaseUrl,
        userAgent: config.github.userAgent,
      }),
    )

    if (!checksResult.ok) {
      return null
    }

    const unresolvedThreads = threadsResult.threads
    const failingChecks = checksResult.checks
    const mergeableState = pull.mergeableState ? pull.mergeableState.toLowerCase() : undefined
    const mergeStateRequiresAttention = mergeableState
      ? !['clean', 'unstable', 'unknown'].includes(mergeableState)
      : false
    const hasMergeConflicts = mergeableState === 'dirty'
    const outstandingWork = unresolvedThreads.length > 0 || failingChecks.length > 0 || hasMergeConflicts
    const shouldForceReviewStage = actionValue ? FORCE_REVIEW_ACTIONS.has(actionValue) : false

    const reviewEvaluation: ReviewEvaluation = {
      outstandingWork,
      forceReview: shouldForceReviewStage,
      isDraft: pull.draft,
      mergeStateRequiresAttention,
      reviewCommand: undefined,
      undraftCommand: undefined,
      readyCommentCommand: undefined,
    }

    const undraftCandidate: UndraftCommand | undefined =
      pull.draft && actionValue !== 'converted_to_draft'
        ? {
            repositoryFullName: repositoryFullName!,
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
    }

    const readyCommentCandidate: ReadyCommentCommandType | undefined =
      !mergeStateRequiresAttention && !shouldForceReviewStage && !outstandingWork
        ? {
            repositoryFullName: repositoryFullName!,
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
    }

    if (shouldRequestReviewGuard({ commands: [] }, { type: 'PR_ACTIVITY', data: reviewEvaluation })) {
      const summaryParts: string[] = []
      if (unresolvedThreads.length > 0) {
        summaryParts.push(
          `${unresolvedThreads.length} unresolved review thread${unresolvedThreads.length === 1 ? '' : 's'}`,
        )
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
        repositoryFullName: repositoryFullName!,
        issueNumber,
        baseBranch: pull.baseRef,
        headBranch: pull.headRef,
        issueUrl: pull.htmlUrl,
        reviewContext,
      })

      const codexMessage: CodexTaskMessage = {
        stage: 'review',
        prompt,
        repository: repositoryFullName!,
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

      const codexStructuredMessage = toCodexTaskProto(codexMessage, deliveryId)

      const reviewHeaders = buildReviewHeaders(headers)

      reviewEvaluation.reviewCommand = {
        stage: 'review',
        key: `pull-${pull.number}-review`,
        codexMessage,
        structuredMessage: codexStructuredMessage,
        topics: {
          codex: config.topics.codex,
          codexStructured: config.topics.codexStructured,
        },
        jsonHeaders: reviewHeaders.json,
        structuredHeaders: reviewHeaders.structured,
      }
    }

    const evaluation = evaluateCodexWorkflow({
      type: 'PR_ACTIVITY',
      data: reviewEvaluation,
    })

    const { stage } = await executeWorkflowCommands(evaluation.commands, executionContext)
    return stage ?? null
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
