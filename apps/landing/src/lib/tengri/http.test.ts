import { describe, expect, mock, test } from 'bun:test'

void mock.module('server-only', () => ({}))
const { MAX_TENGRI_ACTION_BODY_BYTES, readTengriJsonBody, requireSameOrigin, tengriRouteError } = await import('./http')

describe('Tengri BFF request bodies', () => {
  test('parses a bounded UTF-8 JSON body', async () => {
    const request = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: JSON.stringify({ action: 'create-agent', displayName: 'Tengri' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await readTengriJsonBody(request)).toEqual({ action: 'create-agent', displayName: 'Tengri' })
  })

  test('rejects declared and streamed oversized bodies with 413', async () => {
    const declared = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: '{}',
      headers: {
        'content-length': String(MAX_TENGRI_ACTION_BODY_BYTES + 1),
        'content-type': 'application/json',
      },
    })
    const streamed = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: new Uint8Array(MAX_TENGRI_ACTION_BODY_BYTES + 1),
      headers: { 'content-type': 'application/json' },
    })

    for (const request of [declared, streamed]) {
      const error = await readTengriJsonBody(request).catch((cause: unknown) => cause)
      const response = tengriRouteError(error)
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'Tengri action body is too large' })
    }
  })

  test('rejects malformed UTF-8 as invalid JSON without echoing input', async () => {
    const request = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: new Uint8Array([0xff]),
      headers: { 'content-type': 'application/json' },
    })
    const error = await readTengriJsonBody(request).catch((cause: unknown) => cause)
    const response = tengriRouteError(error)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Request body is invalid JSON' })
  })

  test('requires JSON and rejects cross-origin state-changing requests', async () => {
    process.env.BETTER_AUTH_URL = 'https://proompteng.ai'
    const wrongType = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'text/plain' },
    })
    const typeError = await readTengriJsonBody(wrongType).catch((cause: unknown) => cause)
    expect(tengriRouteError(typeError).status).toBe(415)

    const sameOrigin = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      headers: { origin: 'https://proompteng.ai', 'sec-fetch-site': 'same-origin' },
    })
    expect(() => requireSameOrigin(sameOrigin)).not.toThrow()

    for (const origin of ['https://attacker.example', '']) {
      const request = new Request('https://proompteng.ai/api/tengri', {
        method: 'POST',
        headers: origin ? { origin, 'sec-fetch-site': 'cross-site' } : undefined,
      })
      const error = (() => {
        try {
          requireSameOrigin(request)
          return null
        } catch (cause) {
          return cause
        }
      })()
      expect(tengriRouteError(error).status).toBe(403)
    }
  })
})
