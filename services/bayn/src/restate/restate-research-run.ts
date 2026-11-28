import * as restate from '@restatedev/restate-sdk'
import { Redacted, Result } from 'effect'

import { hashResearch, type ResearchRun, type ResearchReceipt } from '../research-inference/contract'
import { decodeApprovedResearchRun } from '../research-inference/approval'

export interface ResearchRuntime {
  readonly run: (run: ResearchRun, signal: AbortSignal) => Promise<ResearchReceipt>
}
export const makeBaynResearchRun = (
  runtime: ResearchRuntime,
  approvalKey: Redacted.Redacted<string>,
  hooks: readonly restate.HooksProvider[] = [],
) =>
  restate.workflow({
    name: 'BaynResearchRun',
    options: { inactivityTimeout: 240_000, abortTimeout: 10_000, hooks: [...hooks] },
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: unknown) => {
        const decoded = decodeApprovedResearchRun(input, approvalKey)
        if (Result.isFailure(decoded)) throw new restate.TerminalError(decoded.failure.message)
        const identity = hashResearch(decoded.success)
        if (Result.isFailure(identity) || identity.success !== ctx.key)
          throw new restate.TerminalError('Research Workflow key must equal the canonical run hash')
        const signal = ctx.request().attemptCompletedSignal
        const receipt = await ctx.run('bounded-research-attempt', () => runtime.run(decoded.success, signal), {
          maxRetryAttempts: 0,
        })
        if (receipt.runId !== ctx.key)
          throw new restate.TerminalError('Research runtime returned a different run identity')
        return receipt
      },
    },
  })
