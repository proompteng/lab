import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { makeProtectiveStopDocumentFixture } from '../jev/exit-document.test-support'
import { makeReconciledStateEvidence, reconciledStateHash, reconciledStateHashFromDecoded } from './broker-model'

test('owned evidence survives decoded copies without trusting aliases, claimed hashes or changed cuts', async () => {
  const document = await Effect.runPromise(makeProtectiveStopDocumentFixture())
  const brokerState = document.plannerInput?.brokerState
  if (brokerState === undefined) throw new Error('protective fixture requires broker state')
  const source = structuredClone(brokerState)
  const receipt = Result.getOrThrow(makeReconciledStateEvidence(source))
  const expected = reconciledStateHash(source)
  expect(reconciledStateHashFromDecoded(structuredClone(source), receipt)).toEqual(expected)
  expect(reconciledStateHashFromDecoded(source, { kind: 'invocation-owned-reconciled-state' })).toEqual(expected)
  for (const mutate of [
    (state: typeof source) => {
      Object.defineProperty(state, 'accountingHash', { value: 'f'.repeat(64), enumerable: true })
    },
    (state: typeof source) => {
      Object.defineProperty(state.account, 'accountId', { value: 'wrong-account', enumerable: true })
    },
    (state: typeof source) => {
      Object.defineProperty(state, 'ordersObservedAt', { value: '2026-01-01T00:00:00.000Z', enumerable: true })
    },
    (state: typeof source) => {
      Object.defineProperty(state.orders[0], 'quantityAtoms', { value: '999', enumerable: true })
    },
  ]) {
    const changed = structuredClone(source)
    mutate(changed)
    expect(reconciledStateHashFromDecoded(changed, receipt)).toEqual(reconciledStateHash(changed))
    expect(reconciledStateHashFromDecoded(changed, receipt)).not.toEqual(expected)
  }
  Object.defineProperty(source.orders[0], 'quantityAtoms', { value: '888', enumerable: true })
  expect(reconciledStateHashFromDecoded(source, receipt)).toEqual(reconciledStateHash(source))
  expect(reconciledStateHashFromDecoded(source, receipt)).not.toEqual(expected)
})

test('owned evidence retains accessor, symbol, type and proxy failure behavior', async () => {
  const document = await Effect.runPromise(makeProtectiveStopDocumentFixture())
  const brokerState = document.plannerInput?.brokerState
  if (brokerState === undefined) throw new Error('protective fixture requires broker state')
  const source = structuredClone(brokerState)
  const receipt = Result.getOrThrow(makeReconciledStateEvidence(source))
  let reads = 0
  const accessor = structuredClone(source)
  Object.defineProperty(accessor.orders[0], 'quantityAtoms', {
    enumerable: true,
    get: () => {
      reads++
      return source.orders[0]!.quantityAtoms
    },
  })
  expect(reconciledStateHashFromDecoded(accessor, receipt)).toEqual(reconciledStateHash(accessor))
  expect(Result.isFailure(reconciledStateHashFromDecoded(accessor, receipt))).toBe(true)
  expect(reads).toBe(0)
  const symbol = structuredClone(source)
  Object.defineProperty(symbol.orders, Symbol('extra'), { value: true })
  expect(reconciledStateHashFromDecoded(symbol, receipt)).toEqual(reconciledStateHash(symbol))
  expect(Result.isFailure(reconciledStateHashFromDecoded(symbol, receipt))).toBe(true)
  const altered = structuredClone(source)
  Object.defineProperty(altered.orders[0], 'quantityAtoms', { value: 1, enumerable: true })
  expect(reconciledStateHashFromDecoded(altered, receipt)).toEqual(reconciledStateHash(altered))
  const proxy = { ...source, orders: new Proxy(source.orders, {}) }
  expect(reconciledStateHashFromDecoded(proxy, receipt)).toEqual(reconciledStateHash(proxy))
})
