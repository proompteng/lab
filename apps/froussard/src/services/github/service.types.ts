import type { Effect } from 'effect'

import type {
  CreateIssueCommentOptions,
  CreateIssueCommentResult,
  ApprovePullRequestOptions,
  ApprovePullRequestResult,
  FetchPullRequestOptions,
  FetchPullRequestResult,
  IssueReactionPresenceOptions,
  IssueReactionPresenceResult,
  ListBlockingChecksOptions,
  ListCommitPullRequestsResult,
  ListBlockingChecksResult,
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
  readonly listCommitPullRequests: (options: ListBlockingChecksOptions) => Effect.Effect<ListCommitPullRequestsResult>
  readonly postIssueReaction: (options: PostIssueReactionOptions) => Effect.Effect<PostIssueReactionResult>
  readonly postIssueCommentReaction: (
    options: PostIssueCommentReactionOptions,
  ) => Effect.Effect<PostIssueCommentReactionResult>
  readonly issueHasReaction: (options: IssueReactionPresenceOptions) => Effect.Effect<IssueReactionPresenceResult>
  readonly createIssueComment: (options: CreateIssueCommentOptions) => Effect.Effect<CreateIssueCommentResult>
  readonly fetchPullRequest: (options: FetchPullRequestOptions) => Effect.Effect<FetchPullRequestResult>
  readonly markPullRequestReadyForReview: (options: ReadyForReviewOptions) => Effect.Effect<ReadyForReviewResult>
  readonly approvePullRequest: (options: ApprovePullRequestOptions) => Effect.Effect<ApprovePullRequestResult>
  readonly listPullRequestReviewThreads: (options: ListReviewThreadsOptions) => Effect.Effect<ListReviewThreadsResult>
  readonly listPullRequestBlockingChecks: (
    options: ListBlockingChecksOptions,
  ) => Effect.Effect<ListBlockingChecksResult>
}
