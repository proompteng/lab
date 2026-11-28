import { readFileSync } from 'node:fs'
import { Result, Schema } from 'effect'

import { JevEntryTargetSchema } from '../src/jev/decision'
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
