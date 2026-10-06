import { expect, test } from 'bun:test'
import { CaptureInvalidation } from '../research-capture/capture'
import { assertUnfaultedCapacitySeal } from './capture-capacity-seal'

test.each([false, true])('uninjected clean capture requires its durable seal, burst=%s', (burst) => {
  expect(() => assertUnfaultedCapacitySeal({ burst, invalidations: [], seals: [{ invalidations: [] }] })).not.toThrow()
  expect(() => assertUnfaultedCapacitySeal({ burst, invalidations: [], seals: [] })).toThrow()
  expect(() =>
    assertUnfaultedCapacitySeal({ burst, invalidations: [], seals: [{ invalidations: [] }, { invalidations: [] }] }),
  ).toThrow()
})
test('only a durable overflow-only burst is accepted as incomplete', () => {
  const invalidations = [CaptureInvalidation.Overflow]
  expect(() => assertUnfaultedCapacitySeal({ burst: true, invalidations, seals: [{ invalidations }] })).not.toThrow()
  expect(() => assertUnfaultedCapacitySeal({ burst: true, invalidations, seals: [] })).toThrow()
  expect(() => assertUnfaultedCapacitySeal({ burst: false, invalidations, seals: [{ invalidations }] })).toThrow()
  expect(() => assertUnfaultedCapacitySeal({ burst: true, invalidations, seals: [{ invalidations: [] }] })).toThrow()
})
test.each([CaptureInvalidation.Persistence, CaptureInvalidation.Finalization, CaptureInvalidation.Interrupted])(
  'burst cannot turn %s into qualifying evidence',
  (reason) => {
    for (const invalidations of [[reason], [CaptureInvalidation.Overflow, reason]]) {
      expect(() => assertUnfaultedCapacitySeal({ burst: true, invalidations, seals: [] })).toThrow()
      expect(() => assertUnfaultedCapacitySeal({ burst: true, invalidations, seals: [{ invalidations }] })).toThrow()
    }
    expect(() =>
      assertUnfaultedCapacitySeal({
        burst: true,
        invalidations: [CaptureInvalidation.Overflow],
        seals: [{ invalidations: [reason] }],
      }),
    ).toThrow()
  },
)
