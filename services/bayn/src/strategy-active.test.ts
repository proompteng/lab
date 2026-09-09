import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeRuntimeProvenance } from './contracts'
import { canonicalHashV1OrThrow } from './hash'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  loadActiveStrategyProtocol,
  makeActiveStrategyRuntime,
} from './strategy'

describe('active strategy composition', () => {
  test('selects the reviewed full-session intraday definition and protocol at the production boundary', () => {
    const protocol = Result.getOrThrow(loadActiveStrategyProtocol())
    const parameterHash = canonicalHashV1OrThrow(protocol)
    const provenance = makeRuntimeProvenance({
      sourceRevision: 'a'.repeat(40),
      image: {
        repository: 'registry.ide-newton.ts.net/lab/bayn',
        digest: `sha256:${'b'.repeat(64)}`,
      },
      strategy: {
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash,
        parameterSchemaVersion: protocol.schemaVersion,
      },
    })

    const runtime = makeActiveStrategyRuntime(protocol, provenance)

    expect(runtime.definition.name).toBe('intraday-momentum')
    expect(runtime.definition.holdingPeriod).toBe('INTRADAY')
    expect(runtime.definition.parameters).toBe(protocol)
    expect(runtime.provenance.strategy).toEqual({
      name: 'intraday-momentum',
      behaviorHash: activeStrategyBehaviorHash,
      parameterHash,
      parameterSchemaVersion: 'bayn.intraday-momentum.protocol.v2',
    })
  })
})
