import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'
import {
  verifyBehaviorHash,
  verifyExecutionRiskPolicyHash,
  verifyParameterHash,
  verifyStrategyName,
  verifyStrategyProtocolHash,
  type EmbeddedBuildMetadata,
  type EmbeddedRuntimeIdentity,
} from './build'
import { canonicalHashV1Result } from './hash'
import { decodeJevProtocol, defaultJevProtocolDocument } from './jev/protocol'

describe('compiled build identity', () => {
  test('rejects build metadata for different compiled parameters', async () => {
    const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    const parameterHash = Result.getOrThrow(canonicalHashV1Result(protocol))
    const metadata: EmbeddedBuildMetadata = {
      sourceRevision: 'a'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      strategyBehaviorHash: 'b'.repeat(64),
      strategyParameterHash: parameterHash,
    }

    await Effect.runPromise(verifyParameterHash(metadata, parameterHash))
    await Effect.runPromise(verifyBehaviorHash(metadata, 'b'.repeat(64)))
    const exit = await Effect.runPromiseExit(
      verifyParameterHash({ ...metadata, strategyParameterHash: '0'.repeat(64) }, parameterHash),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain('compiled strategy parameters')
    const behaviorExit = await Effect.runPromiseExit(
      verifyBehaviorHash({ ...metadata, strategyBehaviorHash: '0'.repeat(64) }, 'b'.repeat(64)),
    )
    expect(Exit.isFailure(behaviorExit)).toBe(true)
    if (Exit.isFailure(behaviorExit)) expect(behaviorExit.cause.toString()).toContain('compiled strategy behavior')
  })

  test('rejects build metadata for a different complete strategy identity', async () => {
    const identity: EmbeddedRuntimeIdentity = {
      strategyName: 'jev',
      strategyProtocolHash: '1'.repeat(64),
      executionRiskPolicyHash: '3'.repeat(64),
    }

    await Effect.runPromise(verifyStrategyName(identity, 'jev'))
    await Effect.runPromise(verifyStrategyProtocolHash(identity, '1'.repeat(64)))
    await Effect.runPromise(verifyExecutionRiskPolicyHash(identity, '3'.repeat(64)))

    const nameExit = await Effect.runPromiseExit(verifyStrategyName(identity, 'different-strategy'))
    expect(Exit.isFailure(nameExit)).toBe(true)
    if (Exit.isFailure(nameExit)) expect(nameExit.cause.toString()).toContain('compiled strategy name')

    const protocolExit = await Effect.runPromiseExit(verifyStrategyProtocolHash(identity, '2'.repeat(64)))
    expect(Exit.isFailure(protocolExit)).toBe(true)
    if (Exit.isFailure(protocolExit)) expect(protocolExit.cause.toString()).toContain('compiled strategy protocol')

    const riskPolicyExit = await Effect.runPromiseExit(verifyExecutionRiskPolicyHash(identity, '4'.repeat(64)))
    expect(Exit.isFailure(riskPolicyExit)).toBe(true)
    if (Exit.isFailure(riskPolicyExit)) {
      expect(riskPolicyExit.cause.toString()).toContain('compiled execution risk policy')
    }
  })
})
