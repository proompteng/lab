import { Context, Layer } from 'effect'

import { createIssueComment, issueHasReaction, postIssueCommentReaction, postIssueReaction } from './issues'
import { fetchPullRequest, markPullRequestReadyForReview } from './pull-requests'
import { listCommitPullRequests, listPullRequestBlockingChecks, listPullRequestReviewThreads } from './reviews'
import type { GithubServiceDefinition } from './service.types'

export class GithubService extends Context.Service<GithubService, GithubServiceDefinition>()(
  '@froussard/GithubService',
) {}

export const GithubServiceLayer = Layer.sync(GithubService, () => ({
  postIssueReaction,
  postIssueCommentReaction,
  issueHasReaction,
  createIssueComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
  listCommitPullRequests,
  listPullRequestReviewThreads,
  listPullRequestBlockingChecks,
}))
