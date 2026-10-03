import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedAuditWriter } from './audit-writer'

afterEach(() => vi.useRealTimers())

describe('bounded audit writer for all event families', () => {
  it('stops after the first backpressured frame and resumes ordered fragments only on drain', async () => {
    const stream = new PassThrough()
    const write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const writer = new BoundedAuditWriter(stream, write)
    expect(writer.enqueue(['input-fragment-0\n', 'input-fragment-1\n', 'result-fragment-2\n'])).toBe(0)
    expect(write.mock.calls.map(([line]) => line)).toEqual(['input-fragment-0\n'])
    const flushed = writer.flush()
    stream.emit('drain')
    expect(write.mock.calls.map(([line]) => line)).toEqual([
      'input-fragment-0\n',
      'input-fragment-1\n',
      'result-fragment-2\n',
    ])
    expect(await flushed).toMatchObject({
      pendingFrames: 0,
      pendingBytes: 0,
      failedWrites: 0,
      rejectedFrames: 0,
      stalled: false,
    })
  })
  it('flushes a call watermark without waiting for later concurrent calls', async () => {
    const stream = new PassThrough()
    const write = vi.fn().mockReturnValue(false)
    const writer = new BoundedAuditWriter(stream, write)
    writer.enqueue(['first-call'])
    const first = writer.flush()
    writer.enqueue(['later-call'])
    stream.emit('drain')
    expect(await first).toMatchObject({ flushed: true })
    expect(write).toHaveBeenCalledTimes(2)
    stream.emit('drain')
    expect(await writer.flush()).toMatchObject({ flushed: true, pendingFrames: 0 })
  })

  it('caps shared queue admission while stalled and rejects a complete event explicitly', () => {
    const stream = new PassThrough()
    const write = vi.fn().mockReturnValue(false)
    const writer = new BoundedAuditWriter(stream, write, 8)
    expect(writer.enqueue(['first', '12345678'])).toBe(2)
    expect(write).not.toHaveBeenCalled()
    expect(writer.enqueue(['first'])).toBe(0)
    expect(writer.enqueue(['12345678'])).toBe(0)
    expect(writer.enqueue(['extra'])).toBe(1)
    expect(writer.status()).toMatchObject({ pendingBytes: 8, pendingFrames: 1, rejectedFrames: 3 })
    stream.emit('error', new Error('synthetic broken pipe'))
  })
  it('bounds stalled flushes and repeated admissions without growing the Writable buffer', async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    const write = vi.fn().mockReturnValue(false)
    const writer = new BoundedAuditWriter(stream, write, 100, 10_000)
    writer.enqueue(['first', 'pending'])
    const flushed = writer.flush()
    vi.advanceTimersByTime(10_001)
    expect(await flushed).toMatchObject({
      pendingBytes: 0,
      pendingFrames: 0,
      rejectedFrames: 1,
      failedWrites: 1,
      stalled: true,
    })
    for (let i = 0; i < 100; i += 1) expect(writer.enqueue(['later'])).toBe(1)
    expect(write).toHaveBeenCalledOnce()
    stream.emit('drain')
    write.mockReturnValue(true)
    expect(writer.enqueue(['recovered'])).toBe(0)
    expect(await writer.flush()).toMatchObject({ pendingFrames: 0, stalled: false })
  })
  it('reports stream errors and synchronous write failures without unhandled errors', async () => {
    const stream = new PassThrough()
    const writer = new BoundedAuditWriter(stream, () => {
      throw new Error('synthetic write failure')
    })
    expect(writer.enqueue(['first', 'second'])).toBe(2)
    expect(await writer.flush()).toMatchObject({ failedWrites: 1, rejectedFrames: 1, stalled: true })
    expect(writer.enqueue(['later'])).toBe(1)
  })
})
