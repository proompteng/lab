import { describe, expect, test } from 'bun:test'

import { createTemporalClient } from '../src/client.ts'
import type { ClientMetadataHeaders } from '../src/client.ts'
import {
  DescribeNamespaceRequest,
  DescribeNamespaceResponse,
  GetWorkerBuildIdCompatibilityRequest,
  GetWorkerBuildIdCompatibilityResponse,
  GetWorkflowExecutionHistoryRequest,
  GetWorkflowExecutionHistoryResponse,
  QueryWorkflowRequest,
  QueryWorkflowResponse,
  RequestCancelWorkflowExecutionRequest,
  RequestCancelWorkflowExecutionResponse,
  SignalWithStartWorkflowExecutionRequest,
  SignalWithStartWorkflowExecutionResponse,
  SignalWorkflowExecutionRequest,
  SignalWorkflowExecutionResponse,
  StartWorkflowExecutionRequest,
  StartWorkflowExecutionResponse,
  TerminateWorkflowExecutionRequest,
  TerminateWorkflowExecutionResponse,
  UpdateWorkerBuildIdCompatibilityRequest,
  UpdateWorkerBuildIdCompatibilityResponse,
} from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import type { WorkflowServiceHandle, WorkflowServiceSubsetClient } from '../src/grpc/workflow-service-client.ts'
import { __TEST_ONLY__ as grpcTestHelpers } from '../src/grpc/workflow-service-client.ts'
import { Payload, Payloads } from '../src/proto/temporal/api/common/v1/message_pb'

const createPayload = (value: string): Payload =>
  new Payload({
    data: new TextEncoder().encode(value),
    metadata: { encoding: new TextEncoder().encode('json/plain') },
  })

const createPayloads = (values: string[]): Payloads =>
  new Payloads({
    payloads: values.map((value) => createPayload(JSON.stringify(value))),
  })

describe('workflow service client helper', () => {
  test('shouldUseTls returns true when allowInsecureTls is set', () => {
    expect(
      grpcTestHelpers.shouldUseTls({
        address: '127.0.0.1:7233',
        allowInsecureTls: true,
      }),
    ).toBe(true)
  })
})

class MockWorkflowService implements WorkflowServiceSubsetClient {
  public startRequests: StartWorkflowExecutionRequest[] = []
  public signalRequests: SignalWorkflowExecutionRequest[] = []
  public metadata: Record<string, string> = {}

  constructor(private readonly describeResponse: DescribeNamespaceResponse = new DescribeNamespaceResponse({})) {}

  async startWorkflowExecution(request: StartWorkflowExecutionRequest): Promise<StartWorkflowExecutionResponse> {
    this.startRequests.push(request)
    return new StartWorkflowExecutionResponse({ runId: 'mock-run-id' })
  }

  async getWorkflowExecutionHistory(
    _request: GetWorkflowExecutionHistoryRequest,
  ): Promise<GetWorkflowExecutionHistoryResponse> {
    return new GetWorkflowExecutionHistoryResponse({})
  }

  async signalWorkflowExecution(_request: SignalWorkflowExecutionRequest): Promise<SignalWorkflowExecutionResponse> {
    return new SignalWorkflowExecutionResponse({})
  }

  async signalWithStartWorkflowExecution(
    _request: SignalWithStartWorkflowExecutionRequest,
  ): Promise<SignalWithStartWorkflowExecutionResponse> {
    return new SignalWithStartWorkflowExecutionResponse({ runId: 'signal-start-run' })
  }

  async queryWorkflow(_request: QueryWorkflowRequest): Promise<QueryWorkflowResponse> {
    return new QueryWorkflowResponse({ queryResult: createPayloads(['value']) })
  }

  async requestCancelWorkflowExecution(
    _request: RequestCancelWorkflowExecutionRequest,
  ): Promise<RequestCancelWorkflowExecutionResponse> {
    return new RequestCancelWorkflowExecutionResponse({})
  }

  async terminateWorkflowExecution(
    _request: TerminateWorkflowExecutionRequest,
  ): Promise<TerminateWorkflowExecutionResponse> {
    return new TerminateWorkflowExecutionResponse({})
  }

  async describeNamespace(_request: DescribeNamespaceRequest): Promise<DescribeNamespaceResponse> {
    return this.describeResponse
  }

  async getWorkerBuildIdCompatibility(
    _request: GetWorkerBuildIdCompatibilityRequest,
  ): Promise<GetWorkerBuildIdCompatibilityResponse> {
    return new GetWorkerBuildIdCompatibilityResponse({})
  }

  async updateWorkerBuildIdCompatibility(
    _request: UpdateWorkerBuildIdCompatibilityRequest,
  ): Promise<UpdateWorkerBuildIdCompatibilityResponse> {
    return new UpdateWorkerBuildIdCompatibilityResponse({})
  }
}

describe('Temporal client (Connect)', () => {
  test('start workflow fills defaults and returns metadata', async () => {
    const service = new MockWorkflowService()
    const { client } = await createTemporalClient({
      config: {
        host: '127.0.0.1',
        port: 7233,
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'sample',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'client-test',
        workerIdentityPrefix: 'temporal-bun-worker',
      },
      workflowServiceFactory: () =>
        ({
          client: service,
          setMetadata: (metadata: Record<string, string>) => {
            service.metadata = metadata
          },
        }) as WorkflowServiceHandle,
    })

    const result = await client.startWorkflow({ workflowId: 'wf-1', workflowType: 'SampleWorkflow', args: ['hello'] })

    expect(result.workflowId).toBe('wf-1')
    expect(result.namespace).toBe('default')
    expect(result.runId).toBe('mock-run-id')
    expect(service.startRequests).toHaveLength(1)
    const startRequest = service.startRequests[0]!
    expect(startRequest.namespace).toBe('default')
    expect(startRequest.workflowType?.name).toBe('SampleWorkflow')
    expect(startRequest.taskQueue?.name).toBe('sample')

    await client.shutdown()
  })

  test('query workflow decodes payloads from response', async () => {
    const service = new MockWorkflowService()
    const { client } = await createTemporalClient({
      config: {
        host: 'localhost',
        port: 7233,
        address: 'http://localhost:7233',
        namespace: 'default',
        taskQueue: 'sample',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'client-test',
        workerIdentityPrefix: 'temporal-bun-worker',
      },
      workflowServiceFactory: () =>
        ({
          client: service,
          setMetadata: (metadata: Record<string, string>) => {
            service.metadata = metadata
          },
        }) as WorkflowServiceHandle,
    })

    const result = await client.workflow.query({ workflowId: 'wf-2' }, 'inspect')
    expect(result).toBe('value')

    await client.shutdown()
  })

  test('updateHeaders validates metadata and forwards to service handle', async () => {
    const service = new MockWorkflowService()
    const { client } = await createTemporalClient({
      config: {
        host: 'localhost',
        port: 7233,
        address: 'http://localhost:7233',
        namespace: 'default',
        taskQueue: 'sample',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'client-test',
        workerIdentityPrefix: 'temporal-bun-worker',
      },
      workflowServiceFactory: () =>
        ({
          client: service,
          setMetadata: (metadata: Record<string, string>) => {
            service.metadata = metadata
          },
        }) as WorkflowServiceHandle,
    })

    await client.updateHeaders({ Authorization: 'Bearer token' } satisfies ClientMetadataHeaders)
    expect(service.metadata.authorization).toBe('Bearer token')

    await client.shutdown()
  })

  test('shutdown prevents further operations', async () => {
    const service = new MockWorkflowService()
    const { client } = await createTemporalClient({
      config: {
        host: 'localhost',
        port: 7233,
        address: 'http://localhost:7233',
        namespace: 'default',
        taskQueue: 'sample',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'client-test',
        workerIdentityPrefix: 'temporal-bun-worker',
      },
      workflowServiceFactory: () =>
        ({
          client: service,
          setMetadata: (metadata: Record<string, string>) => {
            service.metadata = metadata
          },
        }) as WorkflowServiceHandle,
    })

    await client.shutdown()
    await expect(client.startWorkflow({ workflowId: 'wf-3', workflowType: 'Test' })).rejects.toThrow(
      'Temporal client has already been shut down',
    )
  })
})
