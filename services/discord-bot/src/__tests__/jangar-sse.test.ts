import { describe, expect, it } from 'vitest'

import { streamChatCompletionsFromJangar } from '../jangar'

const streamFromChunks = (chunks: string[]) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

describe('streamChatCompletionsFromJangar (SSE parsing)', () => {
  it('yields deltas and terminates on [DONE]', async () => {
    const usagePayload = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n',
      `data: ${JSON.stringify({ usage: usagePayload })}\n`,
      'data: [DONE]\n',
    ].join('')

    const stream = streamFromChunks([sse.slice(0, 25), sse.slice(25)])

    let capturedUsage: unknown
    const fetchImpl: typeof fetch = async () =>
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      })

    let text = ''
    for await (const delta of streamChatCompletionsFromJangar({
      baseUrl: 'http://example.test',
      chatId: 'discord:test',
      prompt: 'hi',
      fetchImpl,
      onUsage: (value) => {
        capturedUsage = value
      },
    })) {
      text += delta
    }

    expect(text).toBe('Hello world')
    expect(capturedUsage).toEqual(usagePayload)
  })
})
