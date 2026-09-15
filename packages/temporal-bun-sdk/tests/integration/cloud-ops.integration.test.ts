import { expect, test } from 'bun:test'

import { createTemporalClient } from '../../src/client'

const cloudAddress = process.env.TEMPORAL_CLOUD_ADDRESS
const cloudApiKey = process.env.TEMPORAL_CLOUD_API_KEY
const cloudApiVersion = process.env.TEMPORAL_CLOUD_API_VERSION ?? '2025-05-31'

const shouldRun = Boolean(cloudAddress && cloudApiKey)
const cloudTest = shouldRun ? test : test.skip

cloudTest('Cloud Ops API getNamespaces returns a response', async () => {
  const { client } = await createTemporalClient({
    cloudAddress,
    cloudApiKey,
    cloudApiVersion,
  })

  try {
    const response = await client.cloud.call('getNamespaces', {})
    expect(response).toBeDefined()
  } finally {
    await client.shutdown()
  }
})
