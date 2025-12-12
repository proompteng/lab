import { DISCORD_MESSAGE_LIMIT } from '@proompteng/discord'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStreamingReply } from '../discord-output'

describe('createStreamingReply', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('splits overflow into follow-up messages', async () => {
    const edits: string[] = []
    const sends: string[] = []

    const makeSentMessage = () => ({
      edit: vi.fn(async (content: string) => {
        edits.push(content)
      }),
    })

    const message = {
      reply: vi.fn(async () => makeSentMessage()),
      channel: {
        send: vi.fn(async (content: string) => {
          sends.push(content)
          return makeSentMessage()
        }),
      },
    }

    const streamer = await createStreamingReply({ message })
    await streamer.pushDelta('a'.repeat(DISCORD_MESSAGE_LIMIT + 50))
    await streamer.finalize()

    expect(message.channel.send).toHaveBeenCalled()
    expect(sends.length).toBeGreaterThan(0)
    expect(edits.length).toBeGreaterThan(0)
  })

  it('throttles edits to at most 1/sec for fast deltas', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const editTimes: number[] = []
    const makeSentMessage = () => ({
      edit: vi.fn(async () => {
        editTimes.push(Date.now())
      }),
    })

    const message = {
      reply: vi.fn(async () => makeSentMessage()),
      channel: {
        send: vi.fn(async () => makeSentMessage()),
      },
    }

    const streamer = await createStreamingReply({ message })
    await streamer.pushDelta('a')
    await streamer.pushDelta('b')
    await streamer.pushDelta('c')

    expect(editTimes.length).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await streamer.finalize()

    expect(editTimes.length).toBeLessThanOrEqual(2)
    if (editTimes.length === 2) {
      expect(editTimes[1] - editTimes[0]).toBeGreaterThanOrEqual(1_000)
    }
  })
})
