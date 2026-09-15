import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Code, ConnectError } from '@connectrpc/connect'

import { createTemporalClient } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, type IntegrationTestEnv } from './test-env'

let env: IntegrationTestEnv | null = null
const hookTimeoutMs = 60_000

beforeAll(async () => {
  env = await acquireIntegrationTestEnv()
}, { timeout: hookTimeoutMs })

afterAll(async () => {
  await releaseIntegrationTestEnv()
}, { timeout: hookTimeoutMs })

test('worker ops and versioning RPCs are reachable', async () => {
  if (!env) {
    throw new Error('integration env not initialised')
  }
  await env.runOrSkip('worker-ops', async () => {
    const config = await loadTemporalConfig({
      defaults: {
        address: env.cliConfig.address,
        namespace: env.cliConfig.namespace,
        taskQueue: env.cliConfig.taskQueue,
      },
    })
    const { client } = await createTemporalClient({ config })

    try {
      const workers = await client.workerOps.list({ namespace: env.cliConfig.namespace })
      expect(workers).toBeDefined()

      await client.workerOps.getVersioningRules({ namespace: env.cliConfig.namespace })
      await client.deployments.listDeployments({ namespace: env.cliConfig.namespace })
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.Unimplemented) {
        console.warn('[temporal-bun-sdk] worker ops RPCs unimplemented, skipping test')
        return
      }
      if (
        error instanceof ConnectError &&
        error.code === Code.PermissionDenied &&
        error.rawMessage.includes('Worker versioning v0.2')
      ) {
        console.warn('[temporal-bun-sdk] worker versioning rules endpoint disabled, skipping test')
        return
      }
      throw error
    } finally {
      await client.shutdown()
    }
  })
})
