import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { decideJevEntry } from '../src/jev/decision'
import { nativeJevDecisionEvidence } from '../src/jev/native.test-support'
import { verifyJevPlan } from './verify-jev-plan'

const evidence = nativeJevDecisionEvidence()
const target = Result.getOrThrow(decideJevEntry(evidence))
const document = { mode: 'PAPER', bindings: { cycleId: evidence.observation.cycleId }, strategyDecision: target }

test('reproduces the sequential selection without claiming broker execution', () => {
  const proof = verifyJevPlan(document)
  expect(proof.reproducedFromSourceAndRawModelAnswers).toBe(true)
  expect(proof.selectedSymbols).toHaveLength(1)
  expect(proof.protectionPlans).toEqual(target.exitPolicy.plans)
  expect(proof.brokerExecutionProven).toBe(false)
})

test('rejects substituted source identity and protected plan', () => {
  expect(() => verifyJevPlan({ ...document, bindings: { cycleId: 'f'.repeat(64) } })).toThrow()
  expect(() =>
    verifyJevPlan({ ...document, strategyDecision: { ...target, exitPolicy: { ...target.exitPolicy, plans: {} } } }),
  ).toThrow()
})
