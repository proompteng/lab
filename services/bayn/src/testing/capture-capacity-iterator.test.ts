import { expect, test } from 'bun:test'

import { CaptureInvalidation, recordResearchCapture } from '../research-capture/capture'
import { observeConsumedRecords } from './capture-capacity-iterator'

test('a pending native pull forwards close immediately without inventing another observation', async () => {
  let release: (result: IteratorResult<number>) => void = () => undefined
  let beganPendingRead: () => void = () => undefined
  const pendingReadStarted = new Promise<void>((resolve) => {
    beganPendingRead = resolve
  })

  let closes = 0
  let pulls = 0
  const pending = new Promise<IteratorResult<number>>((resolve) => {
    release = resolve
  })
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<number>> => {
        if (++pulls === 1) return { done: false, value: 1 }
        beganPendingRead()
        return pending
      },
      return: async () => {
        closes++
        release({ done: true, value: undefined })
        return { done: true, value: undefined }
      },
    }),
  }
  const observed: number[] = []
  const iterator = observeConsumedRecords(source, (value) => observed.push(value))[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: 1 })
  expect(observed).toEqual([])
  const read = iterator.next()
  await pendingReadStarted
  expect(observed).toEqual([1])
  const closing = iterator.return?.()
  const closedWithoutResolvingRead = closes
  release({ done: true, value: undefined })
  await Promise.all([read, closing])
  expect(closedWithoutResolvingRead).toBe(1)
  expect(closes).toBe(1)
  expect(observed).toEqual([1])
})

test('native diagnostic guards escape capture observer exception isolation', async () => {
  let peakRetained = 0
  const invalidations: CaptureInvalidation[] = []
  const exceeded = new Error('Capture retention exceeded its frozen bound')
  const source: AsyncIterable<number> = {
    async *[Symbol.asyncIterator]() {
      recordResearchCapture(
        {
          record: () => {
            peakRetained = 1025
            throw new Error('Optional observer failed')
          },
          invalidate: (reason) => invalidations.push(reason),
        },
        { kind: 'consumer-boundary', consumerEpoch: 'fixture', phase: 'STARTED', positions: [] },
        0,
      )
      yield 1
    },
  }
  const iterator = observeConsumedRecords(source, () => {
    if (peakRetained > 1024) throw exceeded
  })[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: 1 })
  expect(invalidations).toEqual([CaptureInvalidation.InvalidEvent])
  await expect(iterator.next()).rejects.toBe(exceeded)
  await iterator.return?.()
})
