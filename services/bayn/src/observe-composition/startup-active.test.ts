import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeStrategyProtocolHashResult, makeRuntimeProvenanceResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { makeJevDefinition } from '../jev/decision'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  loadActiveStrategyProtocol,
  makeActiveStrategyRuntime,
  type StrategyRuntime,
} from '../strategy'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { prepareObserveStartup } from './startup'

const prepare = (strategy: StrategyRuntime) =>
  prepareObserveStartup({
    accountId: 'test-account',
    authorityGenerationHash: 'b'.repeat(64),
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy,
  })

test('autonomous startup admits the exact source-selected intraday-alpha active identity', () => {
  const activePolicy = Result.getOrThrow(loadActiveStrategyProtocol())
  expect(activePolicy.schemaVersion).toBe('bayn.intraday-alpha-policy.v2')
  const provenance = Result.getOrThrow(
    makeRuntimeProvenanceResult({
      ...fixtureRuntime.provenance,
      strategy: {
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash: Result.getOrThrow(canonicalHashV1Result(activePolicy)),
        parameterSchemaVersion: activePolicy.schemaVersion,
      },
    }),
  )
  const activeRuntime = makeActiveStrategyRuntime(activePolicy, provenance)
  const result = Result.getOrThrow(prepare(activeRuntime))
  expect(result.strategyProtocolHash).toBe(Result.getOrThrow(makeStrategyProtocolHashResult(provenance.strategy)))
  expect(result.strategyProtocolHash).toBe('5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d')
})

test('autonomous startup also admits retained shared v44 protocol evidence', () => {
  expect(fixtureRuntime.definition.parameters.schemaVersion).toBe('bayn.jev.protocol.v44')
  const result = Result.getOrThrow(prepare(fixtureRuntime))
  expect(result.strategyProtocolHash).toBe(
    Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
  )
  expect(result.strategyProtocolHash).toBe('a6b1d3f53ffefeb407e82c2821c7843f4ff0c952ff66ebf714d30aa24f6257f1')
})

test('rejects retired Jev protocols at the only active protocol boundary', () => {
  for (const schemaVersion of [
    'bayn.jev.protocol.v1',
    'bayn.jev.protocol.v2',
    'bayn.jev.protocol.v13',
    'bayn.jev.protocol.v15',
    'bayn.jev.protocol.v18',
    'bayn.jev.protocol.v26',
    'bayn.jev.protocol.v33',
    'bayn.jev.protocol.v34',
  ]) {
    expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, schemaVersion }))).toBe(true)
  }
})

test('a rehashed custom trade-plan protocol cannot substitute for the approved active document', () => {
  const protocol = Result.getOrThrow(
    decodeJevProtocol({ ...fixtureRuntime.definition.parameters, maximumSymbolWeight: 0.19 }),
  )
  const changed: StrategyRuntime = {
    definition: makeJevDefinition(protocol),
    provenance: Result.getOrThrow(
      makeRuntimeProvenanceResult({
        ...fixtureRuntime.provenance,
        strategy: {
          ...fixtureRuntime.provenance.strategy,
          parameterHash: Result.getOrThrow(canonicalHashV1Result(protocol)),
        },
      }),
    ),
  }
  expect(Result.isFailure(prepare(changed))).toBe(true)
})
