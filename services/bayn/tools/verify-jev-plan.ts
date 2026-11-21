import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import { decideJevEntry, JevEntryTargetSchema } from '../src/jev/decision'
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

  const reproduced = Result.getOrThrow(decideJevEntry(target.evidence))
  if (Result.getOrThrow(canonicalHashV1Result(reproduced)) !== Result.getOrThrow(canonicalHashV1Result(target)))
    throw new Error('Stored entry target differs from the single source-derived selector')

  for (const symbol of target.selectedSymbols) {
    const request = target.evidence.batchPlan.candidates.find((candidate) => candidate.symbol === symbol)
    const result = target.evidence.batchResult.candidates.find((candidate) => candidate.symbol === symbol)
    if (
      request?.status !== JevCandidatePlanStatus.Requested ||
      result?.status !== JevCandidateResultStatus.Resolved ||
      result.receipt?.outcome.status !== JevOutcome.Completed
    )
      throw new Error('Selected entry lacks the sealed source request and completed provider evidence')
    const completion = result.receipt.outcome.completion
    if (completion.handoff.disposition.status !== 'READY' || completion.jev.status !== 'RECEIVED')
      throw new Error('Selected entry has no complete sequential provider handoff')
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

const usage = 'Usage: node dist/research/verify-jev-plan.js <private-decision.json> | --help'

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(`${usage}\n`)
  else {
    const path = process.argv[2]
    if (path === undefined) throw new Error(usage)
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    console.log(JSON.stringify(verifyJevPlan(raw)))
  }
}
