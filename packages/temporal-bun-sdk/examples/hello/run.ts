#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const parseName = (argv: string[]): string => {
  const flagIndex = argv.indexOf('--name')
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1]
  }
  return 'Temporal'
}

const resolveTemporalAddress = (input?: string) => {
  const raw = input && input.trim().length > 0 ? input : 'http://127.0.0.1:7233'
  const url = raw.includes('://') ? new URL(raw) : new URL(`http://${raw}`)
  const port = url.port === '' ? '7233' : url.port
  return {
    bridgeAddress: `${url.protocol}//${url.hostname}:${port}`,
    connectionAddress: `${url.hostname}:${port}`,
  }
}

const ensureBundleDependencies = () => {
  const bundleEntry = join(new URL('.', import.meta.url).pathname, 'workflow.ts')
  if (!existsSync(bundleEntry)) {
    throw new Error('Hello workflow entrypoint is missing')
  }
  return bundleEntry
}

const main = async () => {
  process.env.TEMPORAL_BUN_SDK_USE_ZIG ??= '1'

  const { createBridgeClient } = await import('../../src/client')
  const { createBridgeWorker } = await import('../../src/worker')
  const { greet } = await import('./activity')
  const { Connection, WorkflowClient } = await import('@temporalio/client')

  const name = parseName(process.argv)
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default'
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'hello-tq'
  const { bridgeAddress, connectionAddress } = resolveTemporalAddress(process.env.TEMPORAL_ADDRESS)
  const workflowsPath = ensureBundleDependencies()

  const worker = await createBridgeWorker({
    address: connectionAddress,
    namespace,
    taskQueue,
    workflowsPath,
    activities: { greet },
    identity: `hello-worker-${process.pid}`,
  })

  const workerRun = worker.run().catch((error) => {
    console.error('Worker terminated with error', error)
    throw error
  })

  let connection: Awaited<ReturnType<typeof Connection.connect>> | null = null
  let bridgeClient: Awaited<ReturnType<typeof createBridgeClient>> | null = null

  try {
    bridgeClient = await createBridgeClient({ address: bridgeAddress, namespace, taskQueue })
    const workflowId = `hello-${Date.now()}`
    const start = await bridgeClient.startWorkflow({
      workflowId,
      workflowType: 'hello',
      taskQueue,
      args: [name],
    })

    connection = await Connection.connect({ address: connectionAddress })
    const workflowClient = new WorkflowClient({ connection, namespace })
    const handle = workflowClient.getHandle(workflowId, start.runId)
    const result = await handle.result<string>()

    console.log(`RunId: ${start.runId}`)
    console.log(result)
  } finally {
    if (bridgeClient) {
      await bridgeClient.close().catch(() => {})
    }
    if (connection) {
      await connection.close().catch(() => {})
    }
    await worker.shutdown().catch(() => {})
    await workerRun.catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
