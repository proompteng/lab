import { Effect, Layer } from 'effect'

import { createIssueComment, issueHasReaction, postIssueCommentReaction, postIssueReaction } from './issues'
import { fetchPullRequest, markPullRequestReadyForReview } from './pull-requests'
import {
  listCommitPullRequests,
  approvePullRequest,
  listPullRequestBlockingChecks,
  listPullRequestReviewThreads,
} from './reviews'
import type { GithubServiceDefinition } from './service.types'

export class GithubService extends Effect.Tag('@froussard/GithubService')<GithubService, GithubServiceDefinition>() {}

export const GithubServiceLayer = Layer.sync(GithubService, () => ({
  postIssueReaction,
  postIssueCommentReaction,
  issueHasReaction,
  createIssueComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
  approvePullRequest,
  listCommitPullRequests,
  listPullRequestReviewThreads,
  listPullRequestBlockingChecks,
}))
