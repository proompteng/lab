import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  BrokerEnvironment,
  CapitalAccessState,
  ExecutionAccess,
  decodeExecutionAuthority,
  disabledCapitalAccess,
  enabledCapitalAccess,
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
})
