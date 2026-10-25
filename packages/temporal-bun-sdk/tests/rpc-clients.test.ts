import { expect, test } from 'bun:test'
import { createClient } from '@connectrpc/connect'

import { createTemporalClient, temporalCallOptions } from '../src/client'
import { loadTemporalConfig } from '../src/config'
import { OperatorService } from '../src/proto/temporal/api/operatorservice/v1/service_pb'
import { WorkflowService } from '../src/proto/temporal/api/workflowservice/v1/service_pb'

const ensureHeaders = (headers?: Record<string, string>) => headers ?? {}

test('rpc clients forward call options to workflow and operator services', async () => {
  const config = await loadTemporalConfig()
  type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>
  type OperatorServiceClient = ReturnType<typeof createClient<typeof OperatorService>>

  let workflowHeaders: Record<string, string> = {}
  let operatorHeaders: Record<string, string> = {}

  const workflowService = {
    describeNamespace: async (_request, options) => {
      workflowHeaders = ensureHeaders(options.headers)
      return {}
    },
  } as unknown as WorkflowServiceClient

  const operatorService = {
    listSearchAttributes: async (_request, options) => {
      operatorHeaders = ensureHeaders(options.headers)
      return {}
    },
  } as unknown as OperatorServiceClient

  const { client } = await createTemporalClient({
    config,
    workflowService,
    operatorService,
  })

  try {
    await client.rpc.workflow.call(
      'describeNamespace',
      { namespace: config.namespace },
      temporalCallOptions({ headers: { 'x-workflow-rpc': 'ok' } }),
    )
    expect(workflowHeaders['x-workflow-rpc']).toBe('ok')
    expect(client.rpc.workflow.getService()).toBe(workflowService)

    await client.rpc.operator.call(
      'listSearchAttributes',
      { namespace: config.namespace },
      temporalCallOptions({ headers: { 'x-operator-rpc': 'ok' } }),
    )
    expect(operatorHeaders['x-operator-rpc']).toBe('ok')
    expect(client.rpc.operator.getService()).toBe(operatorService)
  } finally {
    await client.shutdown()
  }
})
