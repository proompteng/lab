import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { Authority } from '../paper'
import { BrokerMode } from '../risk'
import {
  BrokerEnvironment,
  CapitalAccessState,
  ExecutionAccess,
  LegacyBrokerMode,
  LegacyMaximumAuthority,
  decodeExecutionAuthority,
  decodeLegacyPaperAuthority,
  disabledCapitalAccess,
  enabledCapitalAccess,
  encodeLegacyPaperAuthority,
  makeExecutionAuthority,
} from './authority'

const failureOf = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isFailure(result)) return result.failure
  throw new Error('expected failure')
}

const policyIdentity = '9a36746eaf154b9ba18cd046c42c1f44f4e93c68d54921fc9ac874fc19f5f13a'

describe('execution authority model', () => {
  test('keeps broker environment, execution access, and capital access orthogonal', () => {
    const environments = [BrokerEnvironment.Sandbox, BrokerEnvironment.Live] as const
    const executionAccesses = [ExecutionAccess.ReadOnly, ExecutionAccess.SubmitOrders] as const
    const capitalAccesses = [disabledCapitalAccess, enabledCapitalAccess(policyIdentity)] as const

    const authorities = environments.flatMap((brokerEnvironment) =>
      executionAccesses.flatMap((executionAccess) =>
        capitalAccesses.map((capitalAccess) =>
          Result.getOrThrow(
            decodeExecutionAuthority(makeExecutionAuthority(brokerEnvironment, executionAccess, capitalAccess)),
          ),
        ),
      ),
    )

    expect(authorities).toHaveLength(8)
    expect(authorities).toContainEqual(
      makeExecutionAuthority(BrokerEnvironment.Live, ExecutionAccess.ReadOnly, disabledCapitalAccess),
    )
    expect(authorities).toContainEqual(
      makeExecutionAuthority(
        BrokerEnvironment.Sandbox,
        ExecutionAccess.SubmitOrders,
        enabledCapitalAccess(policyIdentity),
      ),
    )
  })

  test('requires policy identity only for enabled capital access', () => {
    expect(
      failureOf(
        decodeExecutionAuthority({
          brokerEnvironment: BrokerEnvironment.Live,
          executionAccess: ExecutionAccess.ReadOnly,
          capitalAccess: { _tag: CapitalAccessState.Enabled },
        }),
      ).message,
    ).toContain('policyIdentity')

    expect(
      failureOf(
        decodeExecutionAuthority({
          brokerEnvironment: BrokerEnvironment.Sandbox,
          executionAccess: ExecutionAccess.SubmitOrders,
          capitalAccess: {
            _tag: CapitalAccessState.Disabled,
            policyIdentity,
          },
        }),
      ).message,
    ).toContain('Unexpected key')
  })

  test('preserves existing PAPER and OBSERVE durable identifiers through the legacy adapter', () => {
    expect(String(LegacyBrokerMode.Paper)).toBe('PAPER')
    expect(String(LegacyMaximumAuthority.Observe)).toBe('OBSERVE')
    expect(String(LegacyMaximumAuthority.Paper)).toBe('PAPER')
    expect(String(BrokerMode.Paper)).toBe('PAPER')
    expect(String(Authority.Observe)).toBe('OBSERVE')
    expect(String(Authority.Paper)).toBe('PAPER')

    const observe = Result.getOrThrow(
      decodeLegacyPaperAuthority({
        brokerMode: BrokerMode.Paper,
        maximum: Authority.Observe,
        effective: Authority.Observe,
      }),
    )
    const contained = Result.getOrThrow(
      decodeLegacyPaperAuthority({
        brokerMode: BrokerMode.Paper,
        maximum: Authority.Paper,
        effective: Authority.Observe,
        riskPolicyHash: policyIdentity,
      }),
    )
    const submit = Result.getOrThrow(
      decodeLegacyPaperAuthority({
        brokerMode: BrokerMode.Paper,
        maximum: Authority.Paper,
        effective: Authority.Paper,
        riskPolicyHash: policyIdentity,
      }),
    )

    expect(observe).toEqual(
      makeExecutionAuthority(BrokerEnvironment.Sandbox, ExecutionAccess.ReadOnly, disabledCapitalAccess),
    )
    expect(contained).toEqual(
      makeExecutionAuthority(BrokerEnvironment.Sandbox, ExecutionAccess.ReadOnly, enabledCapitalAccess(policyIdentity)),
    )
    expect(submit).toEqual(
      makeExecutionAuthority(
        BrokerEnvironment.Sandbox,
        ExecutionAccess.SubmitOrders,
        enabledCapitalAccess(policyIdentity),
      ),
    )
    expect(Result.getOrThrow(encodeLegacyPaperAuthority(observe))).toEqual({
      brokerMode: LegacyBrokerMode.Paper,
      maximum: LegacyMaximumAuthority.Observe,
      effective: LegacyMaximumAuthority.Observe,
    })
    expect(Result.getOrThrow(encodeLegacyPaperAuthority(contained))).toEqual({
      brokerMode: LegacyBrokerMode.Paper,
      maximum: LegacyMaximumAuthority.Paper,
      effective: LegacyMaximumAuthority.Observe,
      riskPolicyHash: policyIdentity,
    })
    expect(Result.getOrThrow(encodeLegacyPaperAuthority(submit))).toEqual({
      brokerMode: LegacyBrokerMode.Paper,
      maximum: LegacyMaximumAuthority.Paper,
      effective: LegacyMaximumAuthority.Paper,
      riskPolicyHash: policyIdentity,
    })
  })

  test('fails closed when legacy authority material is incomplete or contradictory', () => {
    expect(
      failureOf(
        decodeLegacyPaperAuthority({
          brokerMode: BrokerMode.Paper,
          maximum: Authority.Paper,
          effective: Authority.Observe,
        }),
      ),
    ).toEqual({
      _tag: 'MissingLegacyRiskPolicyHash',
      maximum: LegacyMaximumAuthority.Paper,
    })

    expect(
      failureOf(
        decodeLegacyPaperAuthority({
          brokerMode: BrokerMode.Paper,
          maximum: Authority.Observe,
          effective: Authority.Observe,
          riskPolicyHash: policyIdentity,
        }),
      ),
    ).toEqual({
      _tag: 'UnexpectedLegacyRiskPolicyHash',
      maximum: LegacyMaximumAuthority.Observe,
      riskPolicyHash: policyIdentity,
    })

    expect(
      failureOf(
        decodeLegacyPaperAuthority({
          brokerMode: BrokerMode.Paper,
          maximum: Authority.Observe,
          effective: Authority.Paper,
        }),
      ),
    ).toEqual({
      _tag: 'LegacyEffectiveAuthorityExceedsMaximum',
      maximum: LegacyMaximumAuthority.Observe,
      effective: LegacyMaximumAuthority.Paper,
    })

    expect(
      failureOf(
        decodeLegacyPaperAuthority({
          brokerMode: 'LIVE',
          maximum: Authority.Observe,
          effective: Authority.Observe,
        }),
      )._tag,
    ).toBe('InvalidLegacyPaperAuthorityMaterial')
  })

  test('rejects new combinations that the legacy paper-only contract cannot represent', () => {
    expect(
      failureOf(
        encodeLegacyPaperAuthority(
          makeExecutionAuthority(BrokerEnvironment.Live, ExecutionAccess.ReadOnly, disabledCapitalAccess),
        ),
      ),
    ).toEqual({
      _tag: 'LegacyBrokerEnvironmentUnsupported',
      brokerEnvironment: BrokerEnvironment.Live,
    })

    expect(
      failureOf(
        encodeLegacyPaperAuthority(
          makeExecutionAuthority(BrokerEnvironment.Sandbox, ExecutionAccess.SubmitOrders, disabledCapitalAccess),
        ),
      ),
    ).toEqual({
      _tag: 'LegacyAuthorityCombinationUnsupported',
      executionAccess: ExecutionAccess.SubmitOrders,
      capitalAccess: CapitalAccessState.Disabled,
    })
  })
})
