import { expect, test } from 'bun:test'
import { createClient } from '@connectrpc/connect'

import { createTemporalClient, temporalCallOptions } from '../src/client'
import { loadTemporalConfig } from '../src/config'
import { CloudService } from '../src/proto/temporal/api/cloud/cloudservice/v1/service_pb'

const cloudConfig = {
  apiKey: 'cloud-test-key',
  apiVersion: '2025-05-31',
}

test('cloud client merges default and call headers', async () => {
  const config = await loadTemporalConfig()
  type CloudServiceClient = ReturnType<typeof createClient<typeof CloudService>>
  let capturedHeaders: Record<string, string> | undefined

  const cloudService = {
    getNamespaces: async (_request, options) => {
      capturedHeaders = { ...(options.headers ?? {}) }
      return {}
    },
  } as unknown as CloudServiceClient

  const { client } = await createTemporalClient({
    config,
    cloudService,
    cloudApiKey: cloudConfig.apiKey,
    cloudApiVersion: cloudConfig.apiVersion,
  })

  try {
    await client.cloud.call('getNamespaces', {})
    expect(capturedHeaders?.authorization).toBe(`Bearer ${cloudConfig.apiKey}`)
    expect(capturedHeaders?.['temporal-cloud-api-version']).toBe(cloudConfig.apiVersion)

    await client.cloud.updateHeaders({ 'x-cloud-test': 'ok' })
    await client.cloud.call('getNamespaces', {}, temporalCallOptions({ headers: { 'x-call-test': 'ok' } }))
    expect(capturedHeaders?.['x-cloud-test']).toBe('ok')
    expect(capturedHeaders?.['x-call-test']).toBe('ok')

    const raw = client.cloud.getService()
    expect(raw).toBe(cloudService)
    expect(client.rpc.cloud).toBe(client.cloud)
  } finally {
    await client.shutdown()
  }
})
