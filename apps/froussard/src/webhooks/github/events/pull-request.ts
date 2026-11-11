import { Schema } from 'effect'
import { deriveRepositoryFullName, type GithubRepository } from '@/github-payload'
import type { WebhookConfig } from '../../types'
import { shouldHandlePullRequestAction } from '../helpers'
import type { WorkflowExecutionContext } from '../workflow'

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

export const handlePullRequestEvent = async (params: PullRequestBaseParams): Promise<void> => {
  const { parsedPayload, executionContext, actionValue, skipActionCheck } = params

  if (!skipActionCheck && !shouldHandlePullRequestAction(actionValue)) {
    return
  }

  const pullRequestPayload = (parsedPayload as { pull_request?: unknown }).pull_request
  if (!pullRequestPayload || typeof pullRequestPayload !== 'object') {
    return
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
    return
  }

  await executionContext.enqueueApproval({ repositoryFullName: repoFullName, pullNumber })
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
