import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { decodeStoredCycleRowValues } from './rows'

describe('cycle store row decoding', () => {
  test('decodes unknown SQL rows exactly once before domain reconstruction', () => {
    expect(decodeStoredCycleRowValues([])).toEqual(Result.succeed([]))
    expect(
      decodeStoredCycleRowValues([
        {
          cycle_id: 'not-a-cycle-id',
          unexpected: true,
        },
      ]),
    ).toMatchObject({ _tag: 'Failure' })
  })
})
