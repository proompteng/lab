import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { handleCreateRun } from '../api'
import { createInMemorySynthesisStore, setSynthesisStoreForTests } from '../store'

const token = 'test-synthesis-token'

const createRunRequest = (authorization?: string) =>
  new Request('http://synthesis.test/api/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ source: 'x.com/home', interests: ['semis'] }),
  })

describe('synthesis REST auth', () => {
  beforeEach(() => {
    process.env.SYNTHESIS_API_TOKEN = token
    setSynthesisStoreForTests(createInMemorySynthesisStore())
  })

  afterEach(() => {
    delete process.env.SYNTHESIS_API_TOKEN
    setSynthesisStoreForTests(null)
  })

  test('rejects missing bearer token for mutating routes', async () => {
    const response = await handleCreateRun(createRunRequest())

    expect(response.status).toBe(401)
  })

  test('accepts a valid bearer token for mutating routes', async () => {
    const response = await handleCreateRun(createRunRequest(`Bearer ${token}`))
    const payload = await response.json()

    expect(response.status).toBe(201)
    expect(payload.run.source).toBe('x.com/home')
  })
})
