import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeRuntimeProvenance, makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1 } from '../hash'
import { makeJevDefinition } from '../jev/decision'
import { decodeJevProtocol, defaultJevProtocolDocument, jevBehaviorHash } from '../jev/protocol'
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

test('autonomous startup admits the exact source-selected momentum-first identity', () => {
  expect(fixtureRuntime.definition.parameters.schemaVersion).toBe('bayn.jev.protocol.v2')
  const result = Result.getOrThrow(prepare(fixtureRuntime))
  expect(result.strategyProtocolHash).toBe(
    Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
  )
  expect(result.strategyProtocolHash).toBe('3b062274793e0a13b97334dbb38858e7322cc045280d0a8ed36b533aa8f38111')
})

test('retained Jev v1 remains decodable but cannot start a new active cycle', () => {
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const legacy: StrategyRuntime = {
    definition: makeJevDefinition(protocol),
    provenance: makeRuntimeProvenance({
      ...fixtureRuntime.provenance,
      strategy: {
        name: 'jev',
        behaviorHash: jevBehaviorHash,
        parameterHash: canonicalHashV1(protocol),
        parameterSchemaVersion: protocol.schemaVersion,
      },
    }),
  }
  const result = prepare(legacy)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure.message).toBe('Jev autonomous execution requires the source-controlled protocol')
})

test('a rehashed custom momentum protocol cannot substitute for the approved active document', () => {
  const protocol = Result.getOrThrow(
    decodeJevProtocol({ ...fixtureRuntime.definition.parameters, minimumEntryProbability: 0.66 }),
  )
  const changed: StrategyRuntime = {
    definition: makeJevDefinition(protocol),
    provenance: makeRuntimeProvenance({
      ...fixtureRuntime.provenance,
      strategy: { ...fixtureRuntime.provenance.strategy, parameterHash: canonicalHashV1(protocol) },
    }),
  }
  expect(Result.isFailure(prepare(changed))).toBe(true)
})
