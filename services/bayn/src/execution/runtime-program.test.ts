import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  liveCapitalAuthority,
  makeExecutionAuthority,
  makeLiveCapitalGrant,
  noCapitalAuthority,
  sandboxCapitalAuthority,
  type ExecutionStrategyIdentity,
} from './authority'
import { makeExecutionProgram, type ExecutionProgramDependencies } from './runtime-program'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const authorityGenerationHash = '1'.repeat(64)
const observedAt = '2026-07-28T08:00:00.000Z'
const strategy: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '2'.repeat(64),
  parameterHash: '3'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const identity = (environment: BrokerEnvironment) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId,
    }),
  )

const dependencies = (label: string): ExecutionProgramDependencies => ({
  brokerRead: {} as ExecutionProgramDependencies['brokerRead'],
  brokerMutation: {
    submit: () => Effect.die(new Error(`${label} submit must not run during composition proof`)),
    cancel: () => Effect.die(new Error(`${label} cancel must not run during composition proof`)),
  },
  intentStore: {} as ExecutionProgramDependencies['intentStore'],
  mutationStore: {} as ExecutionProgramDependencies['mutationStore'],
  writerFence: {} as ExecutionProgramDependencies['writerFence'],
  liveCapitalGrants: {
    read: () => Effect.die(new Error(`${label} live grant read must not run during composition proof`)),
  },
  freshBrokerPrice: () => Effect.die(new Error(`${label} fresh price read must not run during composition proof`)),
  currentUtcInstant: Effect.succeed(observedAt),
})

describe('same-code execution program composition', () => {
  test('uses one program factory for sandbox and live with only injected authority and adapters changed', () => {
    const sandboxIdentity = identity(BrokerEnvironment.Sandbox)
    const liveIdentity = identity(BrokerEnvironment.Live)
    const sandboxAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: sandboxIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
        strategy,
        observedAt,
      }),
    )
    const grant = Result.getOrThrow(
      makeLiveCapitalGrant({
        schemaVersion: 'bayn.live-capital-grant.v1',
        brokerIdentity: liveIdentity,
        authorityGenerationHash,
        strategy,
        limits: {
          maxGrossNotionalMicros: '100000000000',
          maxOrderNotionalMicros: '10000000000',
          maxPositionNotionalMicros: '25000000000',
          maxDailyLossMicros: '1000000000',
          maxOpenOrders: 5,
        },
        validFrom: '2026-07-28T07:00:00.000Z',
        validUntil: '2026-07-28T09:00:00.000Z',
        issuedAt: '2026-07-28T06:00:00.000Z',
        issuedBy: 'operator:test',
      }),
    )
    const liveAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: liveIdentity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: liveCapitalAuthority(grant),
        strategy,
        observedAt,
      }),
    )

    const sandboxProgram = Result.getOrThrow(makeExecutionProgram(sandboxAuthority, dependencies('sandbox')))
    const liveProgram = Result.getOrThrow(makeExecutionProgram(liveAuthority, dependencies('live')))

    expect(sandboxProgram.schemaVersion).toBe('bayn.execution-program.v1')
    expect(liveProgram.schemaVersion).toBe(sandboxProgram.schemaVersion)
    expect(sandboxProgram.authority.brokerIdentity.environment).toBe(BrokerEnvironment.Sandbox)
    expect(liveProgram.authority.brokerIdentity.environment).toBe(BrokerEnvironment.Live)
    expect(sandboxProgram.authority.capitalAuthority._tag).toBe(CapitalAuthorityKind.Sandbox)
    expect(liveProgram.authority.capitalAuthority._tag).toBe(CapitalAuthorityKind.LiveGrant)
  })

  test('cannot construct a mutation program from read-only authority', () => {
    const readOnly = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: identity(BrokerEnvironment.Sandbox),
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: noCapitalAuthority,
        strategy,
        observedAt,
      }),
    )

    expect(makeExecutionProgram(readOnly, dependencies('read-only'))).toEqual(
      Result.fail({
        _tag: 'ExecutionProgramRequiresMutationAuthority',
        brokerAccess: BrokerAccess.ReadOnly,
      }),
    )
  })
})
