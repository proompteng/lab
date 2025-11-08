import { describe, expect, test } from 'bun:test'

import { createGrafClient, type GrafRequestMetadata } from '../../src/graf/client'
import type { GrafConfig } from '../../src/config'

const makeConfig = (): GrafConfig => ({
  serviceUrl: 'http://graf.test',
  headers: { authorization: 'Bearer test' },
  confidenceThreshold: 0.7,
  requestTimeoutMs: 1_000,
  retryPolicy: {
    maxAttempts: 3,
    initialDelayMs: 1,
    maxDelayMs: 1,
    backoffCoefficient: 1,
    retryableStatusCodes: [500],
  },
})

const metadata: GrafRequestMetadata = {
  artifactId: 'artifact-abc',
  workflowId: 'wf-1',
  workflowRunId: 'run-1',
  streamId: 'stream-foo',
}

describe('Graf client', () => {
  test('persistEntities posts metadata to /entities', async () => {
    const client = createGrafClient(makeConfig())
    const requests: Array<{ url: string; init: RequestInit }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      await client.persistEntities(
        { entities: [{ label: 'Company', properties: { name: 'Acme' } }] },
        metadata,
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toHaveLength(1)
    const payload = JSON.parse((requests[0].init.body as string) ?? '{}')
    expect(payload.entities[0]).toEqual({
      label: 'Company',
      properties: { name: 'Acme' },
      artifactId: metadata.artifactId,
      streamId: metadata.streamId,
      researchSource: metadata.workflowRunId,
    })
    const headers = requests[0].init.headers as Record<string, string>
    expect(headers['x-temporal-workflow-id']).toBe(metadata.workflowId)
    expect(headers['x-temporal-workflow-run-id']).toBe(metadata.workflowRunId)
    expect(headers['x-temporal-artifact-id']).toBe(metadata.artifactId)
    expect(headers['x-temporal-stream-id']).toBe(metadata.streamId)
    expect(requests[0].url).toBe('http://graf.test/entities')
  })

  test('persistRelationships posts to /relationships with metadata', async () => {
    const client = createGrafClient(makeConfig())
    const requests: Array<{ url: string; init: RequestInit }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      await client.persistRelationships(
        {
          relationships: [
            {
              type: 'PARTNERS_WITH',
              fromId: 'Acme',
              toId: 'Nvidia',
            },
          ],
        },
        metadata,
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('http://graf.test/relationships')
    const payload = JSON.parse((requests[0].init.body as string) ?? '{}')
    expect(payload.relationships[0]).toMatchObject({
      type: 'PARTNERS_WITH',
      artifactId: metadata.artifactId,
      streamId: metadata.streamId,
      researchSource: metadata.workflowRunId,
    })
  })

  test('retries on retryable failures', async () => {
    const config = makeConfig()
    config.retryPolicy = { ...config.retryPolicy, maxAttempts: 2 }
    const client = createGrafClient(config)
    const attempts: Array<number> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = async () => {
      attempts.push(attempts.length + 1)
      if (attempts.length === 1) {
        return new Response('boom', { status: 500 })
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      await client.persistEntities({ entities: [{ label: 'Company' }] }, metadata)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(attempts).toEqual([1, 2])
  })
})
