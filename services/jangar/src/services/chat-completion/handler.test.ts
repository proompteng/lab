import { beforeEach, describe, expect, it } from 'bun:test'

import { createChatCompletionHandler } from '~/services/chat-completion'
import { activeTurnByChatId, clearActiveTurn, registerActiveTurn, threadMap } from './state'

const handler = createChatCompletionHandler('test-path')

const readText = async (res: Response) => await res.text()

describe('createChatCompletionHandler', () => {
  beforeEach(() => {
    threadMap.clear()
    activeTurnByChatId.clear()
  })

  it('rejects non-stream requests early with SSE error and 400', async () => {
    const body = {
      model: 'gpt-5.1-codex-max',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(400)
    const text = await readText(res)
    expect(text).toContain('stream_required')
    expect(text).toContain('[DONE]')
  })

  it('rejects unsupported models before touching DB', async () => {
    const body = {
      model: 'not-a-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(400)
    const text = await readText(res)
    expect(text).toContain('model_not_supported')
    expect(text).toContain('[DONE]')
  })

  it('returns 400 for invalid JSON bodies', async () => {
    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: '{' }),
    })

    expect(res.status).toBe(400)
    const text = await readText(res)
    expect(text).toContain('invalid_json')
  })

  it('requires messages when streaming', async () => {
    const body = {
      model: 'gpt-5.1-codex-max',
      stream: true,
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(400)
    const text = await readText(res)
    expect(text).toContain('messages_required')
    expect(text).toContain('[DONE]')
  })

  it('does not drop existing thread state on validation errors', async () => {
    const chatId = 'chat-keep'
    threadMap.set(chatId, 'thread-123')

    const body = {
      model: 'not-a-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      chat_id: chatId,
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(400)
    expect(threadMap.get(chatId)).toBe('thread-123')
  })

  it('rejects malformed message entries before DB writes', async () => {
    const body = {
      model: 'gpt-5.1-codex-max',
      stream: true,
      messages: [{ text: 'hi' }],
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(400)
    const text = await readText(res)
    expect(text).toContain('messages_invalid')
    expect(text).toContain('[DONE]')
  })

  it('rejects non-string chat_id and does not alter thread map', async () => {
    const chatId = 1234
    threadMap.set('keep', 'thread-keep')

    const body = {
      model: 'gpt-5.1-codex-max',
      stream: true,
      chat_id: chatId,
      messages: [{ role: 'user', content: 'hi' }],
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(400)
    const text = await readText(res)
    expect(text).toContain('chat_id_invalid')
    expect(threadMap.get('keep')).toBe('thread-keep')
  })

  it('returns 409 when a turn is already active for the chat', async () => {
    const chatId = 'openwebui:conflict-chat'
    registerActiveTurn(chatId, { turnId: 'turn-existing', conversationId: chatId, startedAt: Date.now() })

    const body = {
      model: 'gpt-5.1-codex-max',
      stream: true,
      chat_id: 'conflict-chat',
      messages: [{ role: 'user', content: 'hi again' }],
    }

    const res = await handler({
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    })

    expect(res.status).toBe(409)
    const payload = (await res.json()) as { error?: { code?: string; turn_id?: string } }
    expect(payload.error?.code).toBe('turn_active')
    expect(payload.error?.turn_id).toBe('turn-existing')

    clearActiveTurn(chatId, 'turn-existing')
  })
})
