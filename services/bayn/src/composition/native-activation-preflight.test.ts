import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import {
  executionActivationExpiredRestrictionReason,
  executionMandateCompletedRestrictionReason,
  executionMandateFailureRestrictionPrefix,
  strategyProtocolCutoverRestrictionReason,
} from '../execution/mandate'
import { validateObserveActivationAuthority } from './native-activation-preflight'

const authority: AuthorityState = {
  schemaVersion: 'bayn.paper-authority.v1',
  generationHash: 'a'.repeat(64),
  maximum: Authority.Execution,
  effective: Authority.Execution,
  kill: KillState.Clear,
  version: 1,
  updatedAt: '2026-11-05T18:00:00.000Z',
}

test('an OBSERVE deployment cannot retire a controller with untransitioned PAPER authority', () => {
  const before = structuredClone(authority)
  const result = validateObserveActivationAuthority(authority)
  expect(Result.isFailure(result)).toBe(true)
  expect(authority).toEqual(before)
})

test('first initialization and existing OBSERVE authority remain admissible', () => {
  expect(Result.isSuccess(validateObserveActivationAuthority(null))).toBe(true)
  expect(
    Result.isSuccess(
      validateObserveActivationAuthority({
        ...authority,
        maximum: Authority.Observe,
        effective: Authority.Observe,
      }),
    ),
  ).toBe(true)
})

test.each([
  strategyProtocolCutoverRestrictionReason,
  `${executionMandateFailureRestrictionPrefix} run-cycle-pass: timeout`,
  executionMandateCompletedRestrictionReason,
  executionActivationExpiredRestrictionReason,
])('retains native restricted-generation recovery without performing it: %s', (reason) => {
  const current = { ...authority, effective: Authority.Observe, kill: KillState.Active, reason }
  const before = structuredClone(current)
  expect(Result.isSuccess(validateObserveActivationAuthority(current))).toBe(true)
  expect(current).toEqual(before)
})

test.each(['operator hold', 'unknown restriction', 'reconciliation discrepancy'])(
  'does not bypass an unrelated hold: %s',
  (reason) => {
    expect(
      Result.isFailure(
        validateObserveActivationAuthority({
          ...authority,
          effective: Authority.Observe,
          kill: KillState.Active,
          reason,
        }),
      ),
    ).toBe(true)
  },
)

test('a clear PAPER maximum with OBSERVE effective authority still needs a recognized transition', () => {
  expect(Result.isFailure(validateObserveActivationAuthority({ ...authority, effective: Authority.Observe }))).toBe(
    true,
  )
})
