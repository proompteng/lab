import type { Effect } from 'effect'

import type {
  CreateIssueCommentOptions,
  CreateIssueCommentResult,
  CreatePullRequestCommentOptions,
  CreatePullRequestCommentResult,
  FetchPullRequestOptions,
  FetchPullRequestResult,
  FindPlanCommentOptions,
  FindPlanCommentResult,
  IssueReactionPresenceOptions,
  IssueReactionPresenceResult,
  ListCheckFailuresOptions,
  ListCheckFailuresResult,
  ListReviewThreadsOptions,
  ListReviewThreadsResult,
  PostIssueCommentReactionOptions,
  PostIssueCommentReactionResult,
  PostIssueReactionOptions,
  PostIssueReactionResult,
  ReadyForReviewOptions,
  ReadyForReviewResult,
} from './types'

export interface GithubServiceDefinition {
  readonly postIssueReaction: (options: PostIssueReactionOptions) => Effect.Effect<PostIssueReactionResult>
  readonly postIssueCommentReaction: (
    options: PostIssueCommentReactionOptions,
  ) => Effect.Effect<PostIssueCommentReactionResult>
  readonly issueHasReaction: (options: IssueReactionPresenceOptions) => Effect.Effect<IssueReactionPresenceResult>
  readonly findLatestPlanComment: (options: FindPlanCommentOptions) => Effect.Effect<FindPlanCommentResult>
  readonly createIssueComment: (options: CreateIssueCommentOptions) => Effect.Effect<CreateIssueCommentResult>
  readonly fetchPullRequest: (options: FetchPullRequestOptions) => Effect.Effect<FetchPullRequestResult>
  readonly markPullRequestReadyForReview: (options: ReadyForReviewOptions) => Effect.Effect<ReadyForReviewResult>
  readonly createPullRequestComment: (
    options: CreatePullRequestCommentOptions,
  ) => Effect.Effect<CreatePullRequestCommentResult>
  readonly listPullRequestReviewThreads: (options: ListReviewThreadsOptions) => Effect.Effect<ListReviewThreadsResult>
  readonly listPullRequestCheckFailures: (options: ListCheckFailuresOptions) => Effect.Effect<ListCheckFailuresResult>
}
