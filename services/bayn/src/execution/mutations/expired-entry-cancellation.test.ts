import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { MutationOperation } from '../../broker/alpaca-mutations/model'
import { reconciliationIncompleteRestrictionReason } from '../authority'
import { Authority, KillState, OrderSide } from '../contracts'
import { decodeStartInput, expiredEntryCancellationAdmissionIsCurrent } from './decisions'
import type { ExpiredEntryCancellationAdmission, ExpiredEntryCancellationFacts } from './model'

const admission: ExpiredEntryCancellationAdmission = {
  accountId: 'sandbox-account',
  authorityGenerationHash: 'a'.repeat(64),
  authorityVersion: 2,
  intentId: 'b'.repeat(64),
  clientOrderId: 'parent-client',
  brokerOrderId: 'parent-order',
  observedAt: '2026-11-11T02:00:00.000Z',
  validUntil: '2026-11-11T02:00:30.000Z',
}
const facts: ExpiredEntryCancellationFacts = {
  accountId: admission.accountId,
  authorityGenerationHash: admission.authorityGenerationHash,
  authorityVersion: admission.authorityVersion,
  maximum: Authority.Execution,
  effective: Authority.Observe,
  killState: KillState.Active,
  reason: reconciliationIncompleteRestrictionReason,
  intentId: admission.intentId,
  intentAuthorityGenerationHash: admission.authorityGenerationHash,
  clientOrderId: admission.clientOrderId,
  side: OrderSide.Buy,
  brokerOrderId: admission.brokerOrderId,
  admittedAt: '2026-11-11T02:00:29.999Z',
}

test('expired-entry admission accepts only the exact current clear or recoverably restricted owner', () => {
  expect(expiredEntryCancellationAdmissionIsCurrent(admission, facts)).toBe(true)
  expect(
    expiredEntryCancellationAdmissionIsCurrent(admission, {
      ...facts,
      effective: Authority.Execution,
      killState: KillState.Clear,
    }),
  ).toBe(true)
  expect(
    expiredEntryCancellationAdmissionIsCurrent(admission, {
      ...facts,
      admittedAt: admission.observedAt,
    }),
  ).toBe(true)
})

const invalidFacts: readonly [string, Partial<ExpiredEntryCancellationFacts>][] = [
  ['operator hold', { reason: 'operator hold' }],
  ['authority version changed', { authorityVersion: 3 }],
  ['authority generation changed', { authorityGenerationHash: 'c'.repeat(64) }],
  ['intent generation changed', { intentAuthorityGenerationHash: 'c'.repeat(64) }],
  ['account changed', { accountId: 'other-account' }],
  ['intent changed', { intentId: 'c'.repeat(64) }],
  ['client identity changed', { clientOrderId: 'other-client' }],
  ['parent identity changed', { brokerOrderId: 'other-order' }],
  ['exit intent', { side: OrderSide.Sell }],
  ['OBSERVE maximum', { maximum: Authority.Observe }],
  ['OBSERVE clear', { killState: KillState.Clear }],
  ['PAPER active kill', { effective: Authority.Execution }],
  ['exact expiry', { admittedAt: admission.validUntil }],
  ['past expiry', { admittedAt: '2026-11-11T02:00:30.001Z' }],
  ['future observation', { admittedAt: '2026-11-11T01:59:59.999Z' }],
  ['invalid database time', { admittedAt: 'invalid' }],
  ['unsafe authority version', { authorityVersion: Number.MAX_SAFE_INTEGER + 1 }],
]
for (const [name, patch] of invalidFacts)
  test(`expired-entry admission rejects ${name}`, () => {
    expect(expiredEntryCancellationAdmissionIsCurrent(admission, { ...facts, ...patch })).toBe(false)
  })

test('expired-entry admission rejects missing snapshots and invalid time windows', () => {
  expect(expiredEntryCancellationAdmissionIsCurrent(admission, undefined)).toBe(false)
  for (const patch of [
    { observedAt: 'invalid' },
    { validUntil: 'invalid' },
    { validUntil: admission.observedAt },
    { observedAt: admission.validUntil },
  ])
    expect(expiredEntryCancellationAdmissionIsCurrent({ ...admission, ...patch }, facts)).toBe(false)
})

test('mutation input decoding validates the optional admission without changing the historical input', () => {
  const input = {
    intentId: admission.intentId,
    requestHash: 'd'.repeat(64),
    brokerOrderId: admission.brokerOrderId,
    consistencyDelayMs: 1_000,
    occurredAt: admission.observedAt,
  }
  expect(Result.getOrThrow(decodeStartInput(MutationOperation.Cancel, input))).toEqual(input)
  expect(
    Result.getOrThrow(
      decodeStartInput(MutationOperation.Cancel, {
        ...input,
        expiredEntryCancellation: admission,
      }),
    ),
  ).toEqual({ ...input, expiredEntryCancellation: admission })
  for (const patch of [
    { authorityVersion: 0 },
    { authorityVersion: 1.5 },
    { authorityGenerationHash: 'invalid' },
    { observedAt: 'invalid' },
    { validUntil: 'invalid' },
    { clientOrderId: '' },
    { brokerOrderId: '' },
  ])
    expect(
      Result.isFailure(
        decodeStartInput(MutationOperation.Cancel, {
          ...input,
          expiredEntryCancellation: { ...admission, ...patch },
        }),
      ),
    ).toBe(true)
})
