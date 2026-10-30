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
  expect(fixtureRuntime.definition.parameters.schemaVersion).toBe('bayn.jev.protocol.v32')
  const result = Result.getOrThrow(prepare(fixtureRuntime))
  expect(result.strategyProtocolHash).toBe(
    Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
  )
  expect(result.strategyProtocolHash).toBe('b59f2f378bd0a5ccd8db33883ea77fd6fe5c6c3d9f1d646519973b63710d9f3a')
})

test('rejects retired Jev protocols at the only active protocol boundary', () => {
  for (const schemaVersion of [
    'bayn.jev.protocol.v1',
    'bayn.jev.protocol.v2',
    'bayn.jev.protocol.v13',
    'bayn.jev.protocol.v15',
    'bayn.jev.protocol.v18',
    'bayn.jev.protocol.v26',
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
