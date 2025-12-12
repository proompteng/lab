import { beforeEach, describe, expect, it } from 'vitest'

import { modelsHandler } from '~/routes/openai/v1/models'

describe('/openai/v1/models', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'key'
    process.env.OPENAI_MODELS = 'alpha,beta'
    process.env.OPENAI_BASE_URL = 'https://api.test/v1'
  })

  it('returns configured models list', async () => {
    const response = await modelsHandler()
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(raw)))
    const payload: { data: Array<{ id: string }> } = JSON.parse(raw)
    expect(Array.isArray(payload.data)).toBe(true)
    expect(payload.data.map((m) => m.id)).toEqual([
      'gpt-5.1-codex-max',
      'gpt-5.1-codex',
      'gpt-5.1-codex-mini',
      'gpt-5.1',
      'gpt-5.2',
    ])
  })
})
