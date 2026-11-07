import type { Consumer, EachMessagePayload } from 'kafkajs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/logger'
import { createPolicyWorker } from './worker'

const record = () =>
  ({
    topic: 'froussard.webhook.admissions.v1',
    partition: 1,
    message: {
      offset: '42',
      value: Buffer.from(
        JSON.stringify({ provider: 'github', deliveryId: 'worker-replay', receivedAt: 123, body: '{}', headers: {} }),
      ),
    },
    heartbeat: vi.fn(async () => undefined),
  }) as unknown as EachMessagePayload
const harness = (process: (admission: unknown) => Promise<void>) => {
  const commitOffsets = vi.fn(async (_offsets: unknown) => undefined)
  const consumer = { commitOffsets, disconnect: vi.fn(async () => undefined) } as unknown as Consumer
  return { worker: createPolicyWorker(consumer, process), commitOffsets }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('durable policy worker', () => {
  it('retains the offset after a policy failure and commits only its successful retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const retry = Promise.withResolvers<void>()
    const process = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub unavailable'))
      .mockImplementationOnce(() => retry.promise)
    const { worker, commitOffsets } = harness(process)
    const work = worker.handle(record())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(process).toHaveBeenCalledTimes(2)
    expect(commitOffsets).not.toHaveBeenCalled()
    retry.resolve()
    await work
    expect(commitOffsets).toHaveBeenCalledExactlyOnceWith([
      { topic: 'froussard.webhook.admissions.v1', partition: 1, offset: '43' },
    ])
  })

  it('leaves interrupted work uncommitted so a new worker can replay the same record', async () => {
    const pending = Promise.withResolvers<void>()
    const first = harness(() => pending.promise)
    const work = first.worker.handle(record())
    await first.worker.stop()
    pending.resolve()
    await work
    expect(first.commitOffsets).not.toHaveBeenCalled()
    const replay = harness(async () => undefined)
    await replay.worker.handle(record())
    expect(replay.commitOffsets).toHaveBeenCalledExactlyOnceWith([
      { topic: 'froussard.webhook.admissions.v1', partition: 1, offset: '43' },
    ])
  })

  it('does not skip a corrupt durable record', async () => {
    const { worker, commitOffsets } = harness(async () => undefined)
    const corrupt = record()
    corrupt.message.value = Buffer.from('{}')
    await expect(worker.handle(corrupt)).rejects.toThrow()
    expect(commitOffsets).not.toHaveBeenCalled()
  })
})
