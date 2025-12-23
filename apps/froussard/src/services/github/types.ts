export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>

export interface PostIssueReactionOptions {
  repositoryFullName: string
  issueNumber: number
  token?: string | null
  reactionContent: string
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type PostIssueReactionFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'http-error'
  | 'network-error'

export type PostIssueReactionResult =
  | { ok: true }
  | { ok: false; reason: PostIssueReactionFailureReason; status?: number; detail?: string }

export interface PostIssueCommentReactionOptions {
  repositoryFullName: string
  commentId: number
  token?: string | null
  reactionContent: string
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type PostIssueCommentReactionFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'http-error'
  | 'network-error'

export type PostIssueCommentReactionResult =
  | { ok: true }
  | { ok: false; reason: PostIssueCommentReactionFailureReason; status?: number; detail?: string }

export interface IssueReactionPresenceOptions {
  repositoryFullName: string
  issueNumber: number
  reactionContent: string
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type IssueReactionPresenceFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'http-error'
  | 'network-error'
  | 'invalid-json'

export type IssueReactionPresenceResult =
  | { ok: true; hasReaction: boolean }
  | { ok: false; reason: IssueReactionPresenceFailureReason; status?: number; detail?: string }

export interface PlanComment {
  id: number
  body: string
  htmlUrl: string | null
}

export interface FindPlanCommentOptions {
  repositoryFullName: string
  issueNumber: number
  token?: string | null
  marker?: string
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type FindPlanCommentFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'http-error'
  | 'network-error'
  | 'invalid-json'
  | 'not-found'
  | 'invalid-comment'

export type FindPlanCommentResult =
  | { ok: true; comment: PlanComment }
  | { ok: false; reason: FindPlanCommentFailureReason; status?: number; detail?: string }

export interface CreateIssueCommentOptions {
  repositoryFullName: string
  issueNumber: number
  body: string
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type CreateIssueCommentFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type CreateIssueCommentResult =
  | { ok: true; commentUrl?: string }
  | { ok: false; reason: CreateIssueCommentFailureReason; status?: number; detail?: string }

export interface PullRequestSummary {
  number: number
  title: string
  body: string
  htmlUrl: string
  draft: boolean
  merged: boolean
  state: string
  headRef: string
  headSha: string
  baseRef: string
  authorLogin: string | null
  mergeableState?: string | null
}

export interface FetchPullRequestOptions {
  repositoryFullName: string
  pullNumber: number
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type FetchPullRequestFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'
  | 'not-found'
  | 'invalid-pull-request'

export type FetchPullRequestResult =
  | { ok: true; pullRequest: PullRequestSummary }
  | { ok: false; reason: FetchPullRequestFailureReason; status?: number; detail?: string }

export interface ReadyForReviewOptions {
  repositoryFullName: string
  pullNumber: number
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type ReadyForReviewFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'

export type ReadyForReviewResult =
  | { ok: true }
  | { ok: false; reason: ReadyForReviewFailureReason; status?: number; detail?: string }

export interface CreatePullRequestCommentOptions {
  repositoryFullName: string
  pullNumber: number
  body: string
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type CreatePullRequestCommentFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type CreatePullRequestCommentResult =
  | { ok: true; commentUrl?: string }
  | { ok: false; reason: CreatePullRequestCommentFailureReason; status?: number; detail?: string }

export interface PullRequestReviewThread {
  summary: string
  url?: string
  author?: string
}

export interface ListReviewThreadsOptions {
  repositoryFullName: string
  pullNumber: number
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type ListReviewThreadsFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type ListReviewThreadsResult =
  | { ok: true; threads: PullRequestReviewThread[] }
  | { ok: false; reason: ListReviewThreadsFailureReason; status?: number; detail?: string }

export interface PullRequestCheckFailure {
  name: string
  conclusion?: string
  url?: string
  details?: string
}

export interface ListCheckFailuresOptions {
  repositoryFullName: string
  headSha: string
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type ListCheckFailuresFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type ListCheckFailuresResult =
  | { ok: true; checks: PullRequestCheckFailure[] }
  | { ok: false; reason: ListCheckFailuresFailureReason; status?: number; detail?: string }
