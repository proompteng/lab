import { describe, expect, it } from 'bun:test'

import { createChatCompletionHandler } from '~/services/chat-completion'

const handler = createChatCompletionHandler('test-path')

const readText = async (res: Response) => await res.text()

describe('createChatCompletionHandler', () => {
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
})
