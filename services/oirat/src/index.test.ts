import { describe, expect, it } from 'bun:test'
import { DISCORD_MESSAGE_LIMIT } from '@proompteng/discord'
import type { MessageCreateOptions } from 'discord.js'

import { __testing } from './index'

const { runWithTypingIndicator, buildOpenWebUiChatId, createDiscordStreamWriter } = __testing

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

describe('createDiscordStreamWriter', () => {
  const createThread = () => {
    type Payload = { content?: string | null; components?: unknown }
    const normalize = (payload: string | Payload) =>
      typeof payload === 'string'
        ? { content: payload, components: undefined }
        : { content: payload.content ?? '', components: payload.components }
    const sent: Array<{
      content: string
      creates: Array<{ content: string; components?: unknown }>
      edits: Array<{ content: string; components?: unknown }>
    }> = []
    const thread = {
      send: async (payload: string | Payload) => {
        const normalized = normalize(payload)
        const message = {
          id: `message-${sent.length + 1}`,
          content: normalized.content,
          creates: [normalized],
          edits: [] as Array<{ content: string; components?: unknown }>,
          edit: async (next: string | Payload) => {
            const nextPayload = normalize(next)
            message.content = nextPayload.content
            message.edits.push(nextPayload)
            return message
          },
        }
        sent.push(message)
        return message
      },
      getSent: () => sent,
    }
    return thread
  }

  it('edits the current message as new deltas arrive', async () => {
    const thread = createThread()
    const writer = createDiscordStreamWriter(thread)

    await writer.pushDelta('Hello')
    await writer.pushDelta(' world')
    await writer.pushDelta('!')
    await writer.finalize()

    const sent = thread.getSent()
    expect(sent.length).toBe(1)
    expect(sent[0]?.content).toBe('Hello world!')
  })

  it('splits messages when the content exceeds the Discord limit', async () => {
    const thread = createThread()
    const writer = createDiscordStreamWriter(thread)

    const longDelta = 'x'.repeat(DISCORD_MESSAGE_LIMIT + 10)
    await writer.pushDelta(longDelta)
    await writer.finalize()

    const sent = thread.getSent()
    expect(sent.length).toBe(2)
    expect(sent[0]?.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(sent[1]?.content.length).toBe(10)
  })

  it('clears components on finalize', async () => {
    const thread = createThread()
    const components = ['stop-button'] as unknown as MessageCreateOptions['components']
    const writer = createDiscordStreamWriter(thread, {
      getComponents: () => components,
    })

    await writer.pushDelta('Hello')
    await writer.finalize()

    const sent = thread.getSent()
    expect(sent.length).toBe(1)
    expect(sent[0]?.creates[0]?.components).toEqual(components)
    const lastEdit = sent[0]?.edits.at(-1)
    expect(lastEdit?.components).toEqual([])
  })
})
