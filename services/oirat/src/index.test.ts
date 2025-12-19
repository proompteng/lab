import { describe, expect, it } from 'bun:test'
import { __testing } from './index'

const { runWithTypingIndicator, buildOpenWebUiChatId } = __testing

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('runWithTypingIndicator', () => {
  it('keeps typing until the task completes', async () => {
    let typingCalls = 0
    const thread = {
      id: 'thread-1',
      sendTyping: async () => {
        typingCalls += 1
      },
    }

    const task = async () => {
      await sleep(70)
      return 'done'
    }

    const runPromise = runWithTypingIndicator(thread, task, { intervalMs: 15 })
    await sleep(40)
    expect(typingCalls).toBeGreaterThan(1)

    const result = await runPromise
    expect(result).toBe('done')

    const callsAtEnd = typingCalls
    await sleep(40)
    expect(typingCalls).toBe(callsAtEnd)
  })

  it('stops typing even when the task fails', async () => {
    let typingCalls = 0
    const thread = {
      id: 'thread-2',
      sendTyping: async () => {
        typingCalls += 1
      },
    }

    let caught: Error | undefined
    try {
      await runWithTypingIndicator(
        thread,
        async () => {
          await sleep(40)
          throw new Error('boom')
        },
        { intervalMs: 10 },
      )
    } catch (error) {
      caught = error as Error
    }

    expect(caught?.message).toBe('boom')

    const callsAtEnd = typingCalls
    await sleep(30)
    expect(typingCalls).toBe(callsAtEnd)
  })
})

describe('buildOpenWebUiChatId', () => {
  it('includes guild and thread ids when available', () => {
    const chatId = buildOpenWebUiChatId({ id: 'thread-123', guildId: 'guild-999' })
    expect(chatId).toBe('discord:guild-999:thread-123')
  })

  it('falls back to thread id when guild is missing', () => {
    const chatId = buildOpenWebUiChatId({ id: 'thread-abc', guildId: null })
    expect(chatId).toBe('discord:thread-abc')
  })
})
