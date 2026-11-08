import * as restate from '@restatedev/restate-sdk'
import { Effect, Schema } from 'effect'
import { Webhooks } from '@octokit/webhooks'
import type { AppConfig } from '@/config'
import { logger } from '@/logger'
import { GithubService, GithubServiceLayer } from '@/services/github/service'
import { preparePullRequestApproval, submitPullRequestApproval } from '@/services/github/reviews'
import type { ApprovalReviewResult } from '@/services/github/types'
import {
  ApprovalStateSchema,
  SignedApprovalCommandSchema,
  approvalObjectKey,
  approvalServiceName,
  approvalSignaturePayload,
  type ApprovalState,
} from './contracts'
import { readReadyApproval } from './readiness'
import { isRetryableGitHubFailure } from './failures'

const stateKey = 'review'
export const makeApprovalOwner = (config: { github: AppConfig['github']; webhookSecret: string }) => {
  const githubService = Effect.runSync(
    Effect.gen(function* () {
      return yield* GithubService
    }).pipe(Effect.provide(GithubServiceLayer)),
  )
  const webhooks = new Webhooks({ secret: config.webhookSecret })
  return restate.object({
    name: approvalServiceName,
    handlers: {
      approve: async (ctx: restate.ObjectContext<{ review: ApprovalState }>, candidate: unknown) => {
        const decoded = Schema.decodeUnknownResult(SignedApprovalCommandSchema, { onExcessProperty: 'error' })(
          candidate,
        )
        if (decoded._tag === 'Failure') throw new restate.TerminalError('Invalid approval command', { errorCode: 400 })
        const command = decoded.success
        if (
          ctx.key !== approvalObjectKey(command) ||
          !(await webhooks.verify(approvalSignaturePayload(command), command.signature))
        )
          throw new restate.TerminalError('Approval command authentication failed', { errorCode: 403 })
        const readiness = () =>
          readReadyApproval({
            ...command,
            github: config.github,
            githubService,
            runGithub: (factory) => Effect.runPromise(factory()),
          })
        const previousValue = await ctx.get(stateKey)
        const previousReview =
          previousValue === null
            ? null
            : Schema.decodeUnknownSync(ApprovalStateSchema, { onExcessProperty: 'error' })(previousValue)
        const prepared = await ctx.run('prepare GitHub review', async () => {
          const ready = await readiness()
          if (!ready) return null
          const result = await Effect.runPromise(
            preparePullRequestApproval({ ...ready, ...config.github, previousReview }),
          )
          if (!result.ok)
            logger.warn(
              {
                repository: command.repositoryFullName,
                pullNumber: command.pullNumber,
                reason: result.reason,
                status: result.status,
              },
              'ready approval preparation failed',
            )
          if (!result.ok && isRetryableGitHubFailure(result))
            throw new Error(`GitHub review preparation failed: ${result.reason} ${result.status ?? ''}`)
          return result.ok ? { ready, review: result.review } : null
        })
        if (prepared === null) return { status: 'NOT_READY' }
        const checkpoint = Schema.decodeUnknownSync(ApprovalStateSchema)({
          headSha: prepared.ready.headSha,
          reviewId: prepared.review.id,
          state: prepared.review.state === 'APPROVED' ? 'APPROVED' : 'PENDING',
        })
        ctx.set(stateKey, checkpoint)
        const result = await ctx.run('submit persisted GitHub review', async (): Promise<ApprovalReviewResult> => {
          const ready = await readiness()
          if (!ready) return { ok: false, reason: 'not-ready' }
          if (ready.headSha !== checkpoint.headSha) return { ok: false, reason: 'head-changed' }
          const submitted = await Effect.runPromise(
            submitPullRequestApproval({ ...ready, ...config.github, reviewId: checkpoint.reviewId }),
          )
          if (!submitted.ok && isRetryableGitHubFailure(submitted))
            throw new Error(`GitHub review submission failed: ${submitted.reason} ${submitted.status ?? ''}`)
          return submitted
        })
        if (result.ok) {
          ctx.set(stateKey, { ...checkpoint, state: 'APPROVED' })
          logger.info(
            {
              repository: command.repositoryFullName,
              pullNumber: command.pullNumber,
              headSha: checkpoint.headSha,
              reviewUrl: result.reviewUrl,
              deliveryId: command.deliveryId,
            },
            'ready approval confirmed',
          )
          return { status: 'APPROVED', reviewId: checkpoint.reviewId, reviewUrl: result.reviewUrl }
        }
        logger.warn(
          {
            repository: command.repositoryFullName,
            pullNumber: command.pullNumber,
            reason: result.reason,
            deliveryId: command.deliveryId,
          },
          'ready approval was not submitted',
        )
        return { status: 'NOT_READY', reason: result.reason }
      },
    },
  })
}
