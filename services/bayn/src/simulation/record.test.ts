import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { requiredRecordValue } from './inputs'
import { positionFor, type Position } from './state'

describe('simulation record access', () => {
  test('reads enumerable data properties and distinguishes absence', () => {
    expect(requiredRecordValue({ AAPL: 100n }, 'AAPL', 'price', 'prices')).toEqual(Result.succeed(100n))
    expect(requiredRecordValue({ AAPL: 100n }, 'MSFT', 'price', 'prices')).toEqual(
      Result.fail({
        _tag: 'MissingRecordValue',
        operation: 'price',
        key: 'MSFT',
        context: 'prices',
      }),
    )

    const missingPosition = positionFor({}, 'AAPL')
    assert(Result.isSuccess(missingPosition), 'an absent position must resolve to the immutable zero position')
    expect(missingPosition.success).toEqual({ quantityMicros: 0n, costBasisMicros: 0n })
  })

  test('rejects accessors without invoking them', () => {
    let getterCalls = 0
    const prices: Record<string, bigint> = {}
    Object.defineProperty(prices, 'AAPL', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        throw new Error('simulation lookup must not invoke accessors')
      },
    })

    expect(requiredRecordValue(prices, 'AAPL', 'price', 'prices')).toEqual(
      Result.fail({
        _tag: 'RecordAccessFailed',
        operation: 'price',
        key: 'AAPL',
        context: 'prices',
        reason: 'non-data-property',
        cause: undefined,
      }),
    )
    expect(getterCalls).toBe(0)
  })

  test('retains hostile record introspection as a typed failure', () => {
    const cause = new Error('descriptor trap failed')
    const positions = new Proxy<Record<string, Position>>(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw cause
        },
      },
    )

    expect(positionFor(positions, 'AAPL')).toEqual(
      Result.fail({
        _tag: 'RecordAccessFailed',
        operation: 'position',
        key: 'AAPL',
        context: 'simulation positions',
        reason: 'introspection-failed',
        cause,
      }),
    )
  })
})
