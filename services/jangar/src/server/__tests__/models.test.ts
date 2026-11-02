import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { modelsHandler } from '~/routes/openai/v1/models'

describe('/openai/v1/models', () => {
  const previousEnv: Partial<Record<'JANGAR_MODELS' | 'JANGAR_DEFAULT_MODEL', string | undefined>> = {}

  beforeEach(() => {
    previousEnv.JANGAR_MODELS = process.env.JANGAR_MODELS
    previousEnv.JANGAR_DEFAULT_MODEL = process.env.JANGAR_DEFAULT_MODEL
    process.env.JANGAR_MODELS = 'alpha,beta'
    process.env.JANGAR_DEFAULT_MODEL = 'beta'
  })

  afterEach(() => {
    if (previousEnv.JANGAR_MODELS === undefined) {
      delete process.env.JANGAR_MODELS
    } else {
      process.env.JANGAR_MODELS = previousEnv.JANGAR_MODELS
    }

    if (previousEnv.JANGAR_DEFAULT_MODEL === undefined) {
      delete process.env.JANGAR_DEFAULT_MODEL
    } else {
      process.env.JANGAR_DEFAULT_MODEL = previousEnv.JANGAR_DEFAULT_MODEL
    }
  })

  it('returns configured models list', async () => {
    const response = await modelsHandler()
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(raw)))
    const payload: { data: Array<{ id: string }> } = JSON.parse(raw)
    expect(Array.isArray(payload.data)).toBe(true)
    expect(payload.data.map((m) => m.id)).toEqual(['alpha', 'beta'])
  })
})
