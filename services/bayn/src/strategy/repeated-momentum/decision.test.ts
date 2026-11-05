import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { nativeJevFixture } from '../../jev/native.test-support'
import { JevPurpose } from '../../jev/portfolio'
import { defaultJevProtocolDocument } from '../../jev/protocol'
import { compileJevEntry } from '../../jev/runtime'
import { strictParseOptions } from '../../schemas'
import { makeRepeatedMomentumRuntime } from '../../strategy'
import { fixtureRuntime } from '../../testing/runtime-fixtures'
import { prepareObserveStartup } from '../../observe-composition/startup'
import { decideRepeatedMomentumEntry, MomentumDecisionReason, RepeatedMomentumTargetSchema } from './decision'
import { MomentumExitLevelsSchema, MomentumFundedExitPlanSchema, momentumRequiredTargetNet } from './exit-plan'
import { decodeRepeatedMomentumPolicy, makeRepeatedMomentumPolicy, repeatedMomentumStrategyIdentity } from './policy'

const fixture = (
  returns: Readonly<Record<string, number>> = { AAPL: 0.02, AMZN: 0.01 },
  parameters: unknown = defaultJevProtocolDocument,
) => {
  const source = nativeJevFixture(
    JevPurpose.Entry,
    undefined,
    'momentum-test',
    parameters,
    'a'.repeat(64),
    returns,
    undefined,
    true,
    true,
  )
  const policy = makeRepeatedMomentumPolicy(source.protocol)
  const evidence = {
    schemaVersion: 'bayn.repeated-momentum-evidence.v1' as const,
    observation: source.observation.payload,
    decidedAt: source.observation.payload.observedAt,
  }
  return { source, policy, evidence, target: Result.getOrThrow(decideRepeatedMomentumEntry(evidence, policy)) }
}

test('momentum ranks verified relative returns and funds one position without model receipts', () => {
  const { source, target } = fixture()
  expect(target.selectedSymbols).toEqual(['AAPL'])
  expect(target.signals.map((signal) => signal.symbol)).toEqual(['AAPL', 'AMZN'])
  expect(target.reason).toBe(MomentumDecisionReason.Selected)
  expect(Object.keys(target.evidence)).toEqual(['schemaVersion', 'observation', 'decidedAt'])
  expect(Result.isSuccess(Schema.decodeUnknownResult(RepeatedMomentumTargetSchema, strictParseOptions)(target))).toBe(
    true,
  )
  const plan = target.exitPolicy.plans['AAPL']
  if (plan === undefined) throw new Error('Expected a funded position')
  expect(BigInt(plan.estimatedTargetNetMicros) * 10000n).toBeGreaterThanOrEqual(
    BigInt(plan.acquisitionCostMicros) * 10100n,
  )
  expect(BigInt(plan.estimatedStopNetMicros)).toBeLessThan(BigInt(plan.acquisitionCostMicros))
  expect(target.targetWeights['AAPL']).toBeLessThanOrEqual(source.protocol.maximumSymbolWeight)
  expect(target.targetWeights['AMZN']).toBe(0)
  const compiled = Result.getOrThrow(compileJevEntry(target, source.snapshot, source.snapshot))
  expect(BigInt(compiled.maximumBuyQuantityAtoms['AAPL'] ?? '0')).toBeGreaterThan(0n)
  expect(BigInt(compiled.maximumBuyQuantityAtoms['AAPL'] ?? '0')).toBeLessThanOrEqual(BigInt(plan.maximumQuantityAtoms))
})

test('ties use symbol order and negative or benchmark-underperforming signals abstain', () => {
  expect(fixture({ AAPL: 0.02, AMZN: 0.02 }).target.selectedSymbols).toEqual(['AAPL'])
  const negative = fixture({ AAPL: -0.02, AMZN: -0.01 }).target
  expect(negative.reason).toBe(MomentumDecisionReason.NoSignal)
  expect(negative.selectedSymbols).toEqual([])
  expect(Object.values(negative.targetWeights).every((weight) => weight === 0)).toBe(true)
  expect(negative.exitPolicy.plans).toEqual({})
})

test('a positive signal without fundable quantity abstains instead of forcing activity', () => {
  const { target } = fixture(
    { AAPL: 0.02, AMZN: 0.01 },
    { ...defaultJevProtocolDocument, maximumGrossWeight: 0.000001, maximumSymbolWeight: 0.000001 },
  )
  expect(target.signals[0]?.symbol).toBe('AAPL')
  expect(target.reason).toBe(MomentumDecisionReason.Unfunded)
  expect(target.selectedSymbols).toEqual([])
  expect(target.exitPolicy.plans).toEqual({})
  expect(Object.values(target.targetWeights).every((weight) => weight === 0)).toBe(true)
})

test('momentum target rejects source, weights, exit, ranking and decision-time substitution', () => {
  const { target, evidence, policy } = fixture()
  const selected = target.exitPolicy.plans['AAPL']
  if (selected === undefined) throw new Error('Expected selected source')
  for (const replacement of [
    { reason: MomentumDecisionReason.NoSignal },
    { selectedSymbols: ['AMZN'] },
    { signals: target.signals.slice().reverse() },
    { targetWeights: { ...target.targetWeights, AAPL: 1 } },
    { calendarHash: 'f'.repeat(64) },
    { exitPolicy: { ...target.exitPolicy, plans: {} } },
    { decidedAt: new Date(Date.parse(target.decidedAt) + 1).toISOString() },
  ])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(RepeatedMomentumTargetSchema, strictParseOptions)({ ...target, ...replacement }),
      ),
    ).toBe(true)
  const levels = { ...selected.levels, maximumEntryPriceMicros: '1' }
  expect(Result.isFailure(Schema.decodeUnknownResult(MomentumExitLevelsSchema)(levels))).toBe(true)
  const { planId: _, ...material } = selected.levels
  const modified = {
    ...material,
    profitLimitPriceMicros: (BigInt(material.profitLimitPriceMicros) + 10000n).toString(),
  }
  const rehashed = { ...selected, levels: { ...modified, planId: Result.getOrThrow(canonicalHashV1Result(modified)) } }
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(RepeatedMomentumTargetSchema)({
        ...target,
        exitPolicy: { ...target.exitPolicy, plans: { AAPL: rehashed } },
      }),
    ),
  ).toBe(true)
  for (const millis of [-1, policy.sharedProtocol.inferenceValidityMs]) {
    expect(
      Result.isFailure(
        decideRepeatedMomentumEntry(
          { ...evidence, decidedAt: new Date(Date.parse(evidence.decidedAt) + millis).toISOString() },
          policy,
        ),
      ),
    ).toBe(true)
  }
  expect(
    Result.isFailure(
      decideRepeatedMomentumEntry(
        { ...evidence, observation: { ...evidence.observation, observedAt: '2026-01-01T00:00:00.000Z' } },
        policy,
      ),
    ),
  ).toBe(true)
})

test('momentum identity commits its full policy and rejects unregistered rules', () => {
  const { policy } = fixture()
  const identity = Result.getOrThrow(repeatedMomentumStrategyIdentity(policy))
  expect(identity.strategy.parameterHash).toBe(Result.getOrThrow(canonicalHashV1Result(policy)))
  expect(identity.strategy.parameterSchemaVersion).toBe('bayn.repeated-momentum-policy.v1')
  for (const replacement of [
    { selection: 'HIGHEST_PRICE' },
    { providers: 'JEV' },
    { maximumPositions: 2 },
    { exits: { ...policy.exits, profitTargetNetBps: 200 } },
    { unfundedSelection: 'TRY_NEXT' },
  ])
    expect(Result.isFailure(decodeRepeatedMomentumPolicy({ ...policy, ...replacement }))).toBe(true)
})

test('native startup binds momentum identity and preserves the source-controlled risk protocol', () => {
  const { policy } = fixture()
  const identity = Result.getOrThrow(repeatedMomentumStrategyIdentity(policy))
  const strategy = makeRepeatedMomentumRuntime(policy, { ...fixtureRuntime.provenance, strategy: identity.strategy })
  const input = {
    strategy,
    accountId: 'momentum-test',
    authorityGenerationHash: 'a'.repeat(64),
    pollIntervalMs: 30000,
    reconciliationIntervalMs: 30000,
    reconciliationPassTimeoutMs: 30000,
  }
  const startup = Result.getOrThrow(prepareObserveStartup(input))
  expect(startup.strategyProtocolHash).toBe(identity.protocolHash)
  expect(startup.executionModel).toEqual(policy.sharedProtocol.executionModel)
  expect(
    Result.isFailure(
      prepareObserveStartup({ ...input, strategy: makeRepeatedMomentumRuntime(policy, fixtureRuntime.provenance) }),
    ),
  ).toBe(true)
  const retuned = makeRepeatedMomentumPolicy({
    ...policy.sharedProtocol,
    maximumGrossWeight: 0.1,
    maximumSymbolWeight: 0.1,
  })
  const retunedIdentity = Result.getOrThrow(repeatedMomentumStrategyIdentity(retuned))
  expect(
    Result.isFailure(
      prepareObserveStartup({
        ...input,
        strategy: makeRepeatedMomentumRuntime(retuned, {
          ...fixtureRuntime.provenance,
          strategy: retunedIdentity.strategy,
        }),
      }),
    ),
  ).toBe(true)
})

test('standalone momentum plan decoding rejects a positive target below the frozen one-percent net floor', () => {
  const plan = fixture().target.exitPolicy.plans['AAPL']
  if (plan === undefined) throw new Error('Missing funded plan')
  const floor = momentumRequiredTargetNet(BigInt(plan.acquisitionCostMicros))
  expect(floor - 1n).toBeGreaterThan(BigInt(plan.acquisitionCostMicros))
  for (const offset of [-1n, 0n, 1n]) {
    const decoded = Schema.decodeUnknownResult(MomentumFundedExitPlanSchema)({
      ...plan,
      estimatedTargetNetMicros: (floor + offset).toString(),
    })
    expect(Result.isSuccess(decoded)).toBe(offset >= 0n)
  }
})
