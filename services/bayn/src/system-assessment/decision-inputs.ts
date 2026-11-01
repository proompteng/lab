import { isChartEntryTarget } from '../strategy/runtime-decision'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'

/** Availability comes from each retained provider response and handoff, including failures used to abstain. */
export const requiredInferenceInputs = (strategy: ExecutionDecisionDocument['strategyDecision']) => {
  const inputs: { contentHash: string; availableAt: string }[] = []
  if (!isChartEntryTarget(strategy)) return inputs
  const batch = strategy.evidence.batchResult
  inputs.push({ contentHash: batch.resultHash, availableAt: batch.completedAt })
  for (const candidate of batch.candidates) {
    if (candidate.status !== 'RESOLVED' || candidate.receipt === null) continue
    const receipt = candidate.receipt
    inputs.push({ contentHash: receipt.receiptHash, availableAt: receipt.completedAt })
    if (receipt.outcome.status !== 'COMPLETED') continue
    const completion = receipt.outcome.completion
    inputs.push({ contentHash: completion.handoff.handoffHash, availableAt: completion.handoff.recordedAt })
    const disposition = completion.handoff.disposition
    if (disposition.status === 'VISUAL_FAILED') {
      if (disposition.failure.responseHash !== null)
        inputs.push({ contentHash: disposition.failure.responseHash, availableAt: completion.handoff.recordedAt })
    } else if (disposition.status !== 'SOURCE_INFEASIBLE')
      inputs.push({ contentHash: disposition.visual.responseHash, availableAt: disposition.visual.completedAt })
    const baseStart = completion.handoff.baseStart
    if (baseStart.status === 'RECEIVED')
      inputs.push({ contentHash: baseStart.inference.responseHash, availableAt: baseStart.inference.completedAt })
    else if (baseStart.status === 'FAILED' && baseStart.failure.responseHash !== null)
      inputs.push({ contentHash: baseStart.failure.responseHash, availableAt: completion.handoff.recordedAt })
    else if (baseStart.status === 'NOT_REQUESTED')
      inputs.push({ contentHash: baseStart.skip.skipHash, availableAt: baseStart.skip.recordedAt })
    const jev = completion.jev
    if (jev.status === 'RECEIVED')
      inputs.push({ contentHash: jev.inference.responseHash, availableAt: jev.inference.completedAt })
    else if (jev.status === 'FAILED' && jev.responseHash !== null)
      inputs.push({ contentHash: jev.responseHash, availableAt: completion.completedAt })
  }
  return inputs
}
