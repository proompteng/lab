import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createClient as createConnectClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { temporal } from '@temporalio/proto'

import { createTemporalClient } from '../src'
import { decodePayloadsToValues } from '../src/common/payloads'
import { isTemporalServerAvailable, parseTemporalAddress } from './helpers/temporal-server'
import { waitForWorkerReady, withRetry } from './helpers/retry'
import { WorkflowService } from '../src/proto/temporal/api/workflowservice/v1/service_pb'

const runIntegration = process.env.TEMPORAL_TEST_SERVER === '1'
const autoStartServer = process.env.TEMPORAL_TEST_SERVER_AUTOSTART === '1'
const serverAddressEnv = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? '127.0.0.1:7233'
const namespace = process.env.TEMPORAL_TEST_NAMESPACE ?? 'default'
const taskQueue = process.env.TEMPORAL_TEST_TASK_QUEUE ?? 'bun-connect-integration'
const clientIdentityBase = process.env.TEMPORAL_TEST_CLIENT_IDENTITY ?? `bun-connect-client-${process.pid}`
const baseTimeout = Number.parseInt(process.env.TEMPORAL_TEST_TIMEOUT ?? '5000', 10)
const integrationTimeoutMs = Number.isFinite(baseTimeout) && baseTimeout > 0 ? Math.min(baseTimeout, 5000) : 5000

const STATUS_COMPLETED = 'WORKFLOW_EXECUTION_STATUS_COMPLETED' as const
const EVENT_COMPLETED = 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' as const

const matchesEventType = (value: string | number | undefined, expected: string): boolean => {
  if (typeof value === 'string') {
    return value === expected
  }
  if (typeof value === 'number') {
    const asString = (temporal.api.enums.v1.EventType as unknown as Record<number, string>)[value]
    return asString === expected
  }
  return false
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(__dirname)
const workerScript = join(__dirname, 'worker/run-query-worker.mjs')

const { host: serverHost, port: serverPort } = parseTemporalAddress(serverAddressEnv)
const serverAddress = serverAddressEnv.startsWith('http') ? serverAddressEnv : `http://${serverHost}:${serverPort}`

let serverAvailable = await isTemporalServerAvailable(serverAddress)
let serverStartedByTests = false
let workflowServiceClient: ReturnType<typeof createConnectClient<typeof WorkflowService>> | undefined

if (runIntegration && !serverAvailable && autoStartServer) {
  const result = Bun.spawnSync(['bun', 'scripts/start-temporal-cli.ts'], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) {
    serverStartedByTests = true
    serverAvailable = await isTemporalServerAvailable(serverAddress)
  } else {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ''
    console.warn(`Failed to start Temporal dev server: ${stderr.trim()}`)
  }
}

const suite = runIntegration && serverAvailable ? describe : describe.skip

suite('connect client integration', () => {
  const envBackup: Record<string, string | undefined> = {}
  let workerProcess: ReturnType<typeof Bun.spawn> | undefined

  beforeAll(async () => {
    envBackup.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS
    envBackup.TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE
    envBackup.TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE
    envBackup.TEMPORAL_ALLOW_INSECURE = process.env.TEMPORAL_ALLOW_INSECURE
    envBackup.ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS

    process.env.TEMPORAL_ADDRESS = `${serverHost}:${serverPort}`
    process.env.TEMPORAL_NAMESPACE = namespace
    process.env.TEMPORAL_TASK_QUEUE = taskQueue
    process.env.TEMPORAL_ALLOW_INSECURE = '0'
    delete process.env.ALLOW_INSECURE_TLS

    workflowServiceClient = createConnectClient(
      WorkflowService,
      createGrpcTransport({
        baseUrl: `http://${serverHost}:${serverPort}`,
      }),
    )

    workerProcess = Bun.spawn(
      ['node', workerScript],
      {
        stdout: 'pipe',
        stderr: 'inherit',
        env: {
          ...process.env,
          TEMPORAL_ADDRESS: `${serverHost}:${serverPort}`,
          TEMPORAL_NAMESPACE: namespace,
          TEMPORAL_TASK_QUEUE: taskQueue,
        },
      },
    )

    await waitForWorkerReady(workerProcess, { timeoutMs: 7000 })
  })

  afterAll(async () => {
    if (workerProcess) {
      try {
        workerProcess.kill('SIGINT')
      } catch {
        // ignore
      }
      try {
        await workerProcess.exited
      } catch {
        // ignore
      }
    }

    workflowServiceClient = undefined

    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    if (serverStartedByTests) {
      const stop = Bun.spawnSync(['bun', 'scripts/stop-temporal-cli.ts'], {
        cwd: packageRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (stop.exitCode !== 0) {
        const stderr = stop.stderr ? new TextDecoder().decode(stop.stderr) : ''
        console.warn(`Failed to stop Temporal dev server cleanly: ${stderr.trim()}`)
      }
    }
  })

  const ensureServiceClient = () => {
    if (!workflowServiceClient) {
      throw new Error('Workflow service client not initialized')
    }
    return workflowServiceClient
  }

  const waitForWorkflowStatus = async (
    execution: { workflowId: string; runId?: string },
    expected: typeof STATUS_COMPLETED,
  ): Promise<void> => {
    await withRetry(
      async () => {
        const service = ensureServiceClient()
        const describe = await service.describeWorkflowExecution({
          namespace,
          execution,
        })
        const rawStatus = describe.workflowExecutionInfo?.status
        const statusName = typeof rawStatus === 'string'
          ? rawStatus
          : typeof rawStatus === 'number'
            ? (temporal.api.enums.v1.WorkflowExecutionStatus as unknown as Record<number, string>)[rawStatus] ?? 'WORKFLOW_EXECUTION_STATUS_UNSPECIFIED'
            : 'WORKFLOW_EXECUTION_STATUS_UNSPECIFIED'
        if (statusName !== expected) {
          throw new Error(
            `Workflow not yet ${expected}, current status is ${statusName}`,
          )
        }
      },
      20,
      200,
    )
  }

  const readCompletionPayloads = async (execution: { workflowId: string; runId?: string }) => {
    const service = ensureServiceClient()
    const history = await service.getWorkflowExecutionHistory({
      namespace,
      execution,
      waitNewEvent: false,
      maximumPageSize: 200,
    })
    const events = history.history?.events ?? []
    return events
  }

  test('describes the configured namespace', { timeout: integrationTimeoutMs }, async () => {
    const { client } = await createTemporalClient({
      namespace,
      identity: `${clientIdentityBase}-describe`,
      taskQueue,
    })

    try {
      const payload = await client.describeNamespace(namespace)
      expect(payload.byteLength).toBeGreaterThan(0)
    } finally {
      await client.shutdown()
    }
  })

  test('completes a workflow and retrieves the final result', { timeout: integrationTimeoutMs }, async () => {
    const { client } = await createTemporalClient({
      namespace,
      identity: `${clientIdentityBase}-workflow`,
      taskQueue,
    })

    try {
      const workflowId = `connect-integration-complete-${Date.now()}`
      const startResult = await client.workflow.start({
        workflowId,
        workflowType: 'queryWorkflowSample',
        args: ['initial'],
        taskQueue,
      })

      const handle = startResult.handle

      const initial = await client.workflow.query(handle, 'currentState')
      expect(initial).toBe('initial')

      await client.workflow.signal(handle, 'setState', 'updated')

      await client.workflow.cancel(handle).catch(() => {})
    } finally {
      await client.shutdown()
    }
  })

})
