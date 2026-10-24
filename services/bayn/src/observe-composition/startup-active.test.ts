import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeStrategyProtocolHashResult, makeRuntimeProvenanceResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { makeJevDefinition } from '../jev/decision'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'
import type { StrategyRuntime } from '../strategy'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { prepareObserveStartup } from './startup'

const prepare = (strategy: StrategyRuntime) =>
  prepareObserveStartup({
    accountId: 'test-account',
    authorityGenerationHash: 'b'.repeat(64),
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy,
  })

test('autonomous startup admits the exact source-selected model trade-plan identity', () => {
  expect(fixtureRuntime.definition.parameters.schemaVersion).toBe('bayn.jev.protocol.v21')
  const result = Result.getOrThrow(prepare(fixtureRuntime))
  expect(result.strategyProtocolHash).toBe(
    Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
  )
  expect(result.strategyProtocolHash).toBe('4e239cf431575a9ebaa37abf9b53bb8713baa8cddb3877b18e7815ef14bbbecf')
})

test('rejects retired Jev protocols at the only active protocol boundary', () => {
  for (const schemaVersion of [
    'bayn.jev.protocol.v1',
    'bayn.jev.protocol.v2',
    'bayn.jev.protocol.v13',
    'bayn.jev.protocol.v15',
    'bayn.jev.protocol.v18',
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
