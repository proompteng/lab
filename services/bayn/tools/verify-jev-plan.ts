import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import { JevEntryTargetSchema } from '../src/jev/decision'
import { selectedJevTradePlan } from '../src/jev/trade-plan-choices'
import { JevCandidatePlanStatus, JevCandidateResultStatus } from '../src/jev/batch'
import { JevOutcome } from '../src/jev/evidence'
import { Sha256Schema } from '../src/schemas'

const EvidenceSchema = Schema.Struct({
  bindings: Schema.Struct({ cycleId: Sha256Schema }),
  mode: Schema.Literal('PAPER'),
  strategyDecision: JevEntryTargetSchema,
})

export const verifyJevPlan = (input: unknown) => {
  const evidence = Result.getOrThrow(Schema.decodeUnknownResult(EvidenceSchema)(input))
  const target = evidence.strategyDecision
  if (target.evidence.observation.cycleId !== evidence.bindings.cycleId)
    throw new Error('The decision and source observation identify different cycles')

  for (const symbol of target.selectedSymbols) {
    const request = target.evidence.batchPlan.candidates.find((candidate) => candidate.symbol === symbol)
    const result = target.evidence.batchResult.candidates.find((candidate) => candidate.symbol === symbol)
    if (
      request?.status !== JevCandidatePlanStatus.Requested ||
      result?.status !== JevCandidateResultStatus.Resolved ||
      result.receipt?.outcome.status !== JevOutcome.Received
    )
      throw new Error('Selected entry lacks the sealed request and received model answer')
    const selected = Result.getOrThrow(
      selectedJevTradePlan(request.request.request, result.receipt.outcome.inference.response),
    )
    const bound = target.exitPolicy.plans[symbol]
    if (
      selected === null ||
      bound === undefined ||
      Result.getOrThrow(canonicalHashV1Result(selected)) !== Result.getOrThrow(canonicalHashV1Result(bound))
    )
      throw new Error('Bound protection differs from the complete model-selected plan')
  }

  return {
    reproducedFromSourceAndRawModelAnswers: true,
    cycleId: evidence.bindings.cycleId,
    contract: target.schemaVersion,
    batchContract: target.evidence.batchPlan.schemaVersion,
    protocol: target.evidence.observation.protocol.schemaVersion,
    selectedSymbols: target.selectedSymbols,
    entryPlanRejections: target.entryPlanRejections,
    protectionPlans: target.exitPolicy.plans,
    brokerExecutionProven: false,
  }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined) throw new Error('Usage: bun tools/verify-jev-plan.ts <private-decision.json>')
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  console.log(JSON.stringify(verifyJevPlan(raw)))
}
