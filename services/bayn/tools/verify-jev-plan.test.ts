import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { decideJevEntry } from '../src/jev/decision'
import { nativeJevDecisionEvidence } from '../src/jev/native.test-support'
import { verifyJevPlan } from './verify-jev-plan'

test('the verifier consumes persisted decision bindings and reproduces the complete selected plan', () => {
  const evidence = nativeJevDecisionEvidence()
  const strategyDecision = Result.getOrThrow(decideJevEntry(evidence))
  const document = { mode: 'PAPER', bindings: { cycleId: evidence.observation.cycleId }, strategyDecision }
  expect(verifyJevPlan(document)).toMatchObject({
    cycleId: evidence.observation.cycleId,
    reproducedFromSourceAndRawModelAnswers: true,
    selectedSymbols: ['AAPL'],
    brokerExecutionProven: false,
  })
  expect(() => verifyJevPlan({ ...document, bindings: { cycleId: 'f'.repeat(64) } })).toThrow()
  expect(() => verifyJevPlan({ ...document, bindings: undefined, cycleId: evidence.observation.cycleId })).toThrow()
})
