import assert from 'node:assert/strict'
import { CaptureInvalidation } from '../research-capture/capture'

/** An uninjected arm must have durable evidence; only the burst may end with explicit overflow. */
export const assertUnfaultedCapacitySeal = (input: {
  readonly burst: boolean
  readonly invalidations: readonly string[]
  readonly seals: readonly { readonly invalidations: readonly string[] }[]
}): void => {
  assert.equal(input.seals.length, 1, 'Uninjected capture requires exactly one durable seal')
  const permitted = input.burst && input.invalidations.length > 0 ? [CaptureInvalidation.Overflow] : []
  assert.deepEqual(input.invalidations, permitted, 'Uninjected capture failed for an unpermitted reason')
  assert.deepEqual(input.seals[0]?.invalidations, permitted, 'Durable seal must preserve the exact allowed outcome')
}
