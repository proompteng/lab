import type { Effect } from 'effect'

import type {
  CreatePullRequestCommentOptions,
  CreatePullRequestCommentResult,
  FetchPullRequestOptions,
  FetchPullRequestResult,
  FindPlanCommentOptions,
  FindPlanCommentResult,
  ListCheckFailuresOptions,
  ListCheckFailuresResult,
  ListReviewThreadsOptions,
  ListReviewThreadsResult,
  PostIssueReactionOptions,
  PostIssueReactionResult,
  ReadyForReviewOptions,
  ReadyForReviewResult,
} from './types'

export interface GithubServiceDefinition {
  readonly postIssueReaction: (options: PostIssueReactionOptions) => Effect.Effect<PostIssueReactionResult>
  readonly findLatestPlanComment: (options: FindPlanCommentOptions) => Effect.Effect<FindPlanCommentResult>
  readonly fetchPullRequest: (options: FetchPullRequestOptions) => Effect.Effect<FetchPullRequestResult>
  readonly markPullRequestReadyForReview: (options: ReadyForReviewOptions) => Effect.Effect<ReadyForReviewResult>
  readonly createPullRequestComment: (
    options: CreatePullRequestCommentOptions,
  ) => Effect.Effect<CreatePullRequestCommentResult>
  readonly listPullRequestReviewThreads: (options: ListReviewThreadsOptions) => Effect.Effect<ListReviewThreadsResult>
  readonly listPullRequestCheckFailures: (options: ListCheckFailuresOptions) => Effect.Effect<ListCheckFailuresResult>
}
