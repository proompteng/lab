import type { Effect } from 'effect'
import type { AppConfig } from '@/config'
import { logger } from '@/logger'
import type { GithubServiceDefinition } from '@/services/github/service.types'
import { approvalBody, type ReadyApproval } from './contracts'
import { isRetryableGitHubFailure } from './failures'

export interface ApprovalReadinessOptions {
  repositoryFullName: string
  pullNumber: number
  deliveryId: string
  github: AppConfig['github']
  githubService: Pick<
    GithubServiceDefinition,
    'fetchPullRequest' | 'listPullRequestReviewThreads' | 'listPullRequestBlockingChecks' | 'issueHasReaction'
  >
  runGithub: <A>(factory: () => Effect.Effect<A>) => Promise<A>
}

export const readReadyApproval = async (options: ApprovalReadinessOptions): Promise<ReadyApproval | null> => {
  const { repositoryFullName: repoFullName, pullNumber, deliveryId, github, githubService, runGithub } = options
  const logReadFailure = (stage: string, result: { reason: string; status?: number }) => {
    logger.warn(
      { repository: repoFullName, pullNumber, deliveryId, stage, reason: result.reason, status: result.status },
      'ready approval blocked by GitHub read failure',
    )
    if (isRetryableGitHubFailure(result))
      throw new Error(`GitHub ${stage} read failed: ${result.reason} ${result.status ?? ''}`)
  }
  logger.info({ repository: repoFullName, pullNumber, action: 'reconcile' }, 'processing pull request')
  const pullResult = await runGithub(() =>
    githubService.fetchPullRequest({
      repositoryFullName: repoFullName,
      pullNumber,
      token: github.token,
      apiBaseUrl: github.apiBaseUrl,
      userAgent: github.userAgent,
    }),
  )

  if (!pullResult.ok) {
    logReadFailure('pull-request', pullResult)
    return null
  }

  const pull = pullResult.pullRequest
  if (pull.state !== 'open' || pull.merged) {
    logger.info(
      { repository: repoFullName, pullNumber, state: pull.state, merged: pull.merged },
      'ignoring closed pull request',
    )
    return null
  }

  if (!pull.headRef || !pull.headSha || !pull.baseRef) {
    logger.warn(
      { repository: repoFullName, pullNumber, deliveryId },
      'ready approval blocked by missing pull request refs',
    )
    return null
  }

  const threadsResult = await runGithub(() =>
    githubService.listPullRequestReviewThreads({
      repositoryFullName: repoFullName,
      pullNumber,
      token: github.token,
      apiBaseUrl: github.apiBaseUrl,
      userAgent: github.userAgent,
    }),
  )

  if (!threadsResult.ok) {
    logReadFailure('review-threads', threadsResult)
    return null
  }

  const checksResult = await runGithub(() =>
    githubService.listPullRequestBlockingChecks({
      repositoryFullName: repoFullName,
      headSha: pull.headSha,
      token: github.token,
      apiBaseUrl: github.apiBaseUrl,
      userAgent: github.userAgent,
    }),
  )

  if (!checksResult.ok) {
    logReadFailure('checks', checksResult)
    return null
  }

  const reactionsResult = await runGithub(() =>
    githubService.issueHasReaction({
      repositoryFullName: repoFullName,
      issueNumber: pull.number,
      reactionContent: '+1',
      token: github.token,
      apiBaseUrl: github.apiBaseUrl,
      userAgent: github.userAgent,
    }),
  )

  const hasThumbsUpReaction = reactionsResult.ok ? reactionsResult.hasReaction : false
  if (!reactionsResult.ok) {
    logReadFailure('reactions', reactionsResult)
  }

  const unresolvedThreads = threadsResult.threads
  const blockingChecks = checksResult.checks
  const mergeableState = pull.mergeableState ? pull.mergeableState.toLowerCase() : null
  // GitHub also reports 'blocked' when this approval is the missing requirement.
  const mergeStateRequiresAttention = mergeableState
    ? !['clean', 'unstable', 'blocked', 'unknown'].includes(mergeableState)
    : false
  const hasMergeConflicts = mergeableState === 'dirty'
  const outstandingWork = unresolvedThreads.length > 0 || blockingChecks.length > 0 || hasMergeConflicts

  const readyApproval: ReadyApproval | undefined =
    hasThumbsUpReaction && !mergeStateRequiresAttention && !outstandingWork && !pull.draft
      ? {
          repositoryFullName: repoFullName,
          pullNumber,
          headSha: pull.headSha,
          body: approvalBody(pull.headSha),
        }
      : undefined

  if (!readyApproval) {
    logger.info(
      {
        repository: repoFullName,
        pullNumber,
        headSha: pull.headSha,
        deliveryId,
        blockingChecks: blockingChecks.map(({ name, conclusion }) => ({ name, conclusion })),
        unresolvedThreadCount: unresolvedThreads.length,
        hasThumbsUpReaction,
        draft: pull.draft,
        mergeableState,
      },
      'ready approval blocked',
    )
    return null
  }
  return readyApproval
}
