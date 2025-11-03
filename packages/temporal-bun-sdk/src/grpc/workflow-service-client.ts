import type * as http2 from 'node:http2'

import { type CallOptions, createClient, type Interceptor } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'

import type { TLSConfig } from '../config'
import type {
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
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from '../proto/temporal/api/workflowservice/v1/service_connect'

export interface WorkflowServiceClientOptions {
  address: string
  tls?: TLSConfig
  allowInsecureTls?: boolean
  apiKey?: string
  metadata?: Record<string, string>
}

export interface WorkflowServiceHandle {
  client: WorkflowServiceSubsetClient
  setMetadata(metadata: Record<string, string>): void
}

export interface WorkflowServiceSubsetClient {
  startWorkflowExecution(
    request: StartWorkflowExecutionRequest,
    options?: CallOptions,
  ): Promise<StartWorkflowExecutionResponse>
  signalWorkflowExecution(
    request: SignalWorkflowExecutionRequest,
    options?: CallOptions,
  ): Promise<SignalWorkflowExecutionResponse>
  signalWithStartWorkflowExecution(
    request: SignalWithStartWorkflowExecutionRequest,
    options?: CallOptions,
  ): Promise<SignalWithStartWorkflowExecutionResponse>
  queryWorkflow(request: QueryWorkflowRequest, options?: CallOptions): Promise<QueryWorkflowResponse>
  getWorkflowExecutionHistory(
    request: GetWorkflowExecutionHistoryRequest,
    options?: CallOptions,
  ): Promise<GetWorkflowExecutionHistoryResponse>
  getWorkflowExecutionHistory(
    request: GetWorkflowExecutionHistoryRequest,
    options?: CallOptions,
  ): Promise<GetWorkflowExecutionHistoryResponse>
  requestCancelWorkflowExecution(
    request: RequestCancelWorkflowExecutionRequest,
    options?: CallOptions,
  ): Promise<RequestCancelWorkflowExecutionResponse>
  terminateWorkflowExecution(
    request: TerminateWorkflowExecutionRequest,
    options?: CallOptions,
  ): Promise<TerminateWorkflowExecutionResponse>
  describeNamespace(request: DescribeNamespaceRequest, options?: CallOptions): Promise<DescribeNamespaceResponse>
  getWorkerBuildIdCompatibility(
    request: GetWorkerBuildIdCompatibilityRequest,
    options?: CallOptions,
  ): Promise<GetWorkerBuildIdCompatibilityResponse>
  updateWorkerBuildIdCompatibility(
    request: UpdateWorkerBuildIdCompatibilityRequest,
    options?: CallOptions,
  ): Promise<UpdateWorkerBuildIdCompatibilityResponse>
}

const hasScheme = (value: string): boolean => /^[a-z]+:\/\//i.test(value)

const buildBaseUrl = (address: string, useTls: boolean): string => {
  if (hasScheme(address)) {
    return address
  }
  const schema = useTls ? 'https' : 'http'
  return `${schema}://${address}`
}

const shouldUseTls = (options: WorkflowServiceClientOptions): boolean => {
  return Boolean(options.tls) || options.allowInsecureTls === true
}

export const createWorkflowServiceClient = (options: WorkflowServiceClientOptions): WorkflowServiceHandle => {
  const tls = options.tls
  const useTls = shouldUseTls(options)

  const nodeOptions: Partial<http2.SecureClientSessionOptions & http2.ClientSessionRequestOptions> = {}
  if (tls?.serverRootCACertificate) {
    nodeOptions.ca = tls.serverRootCACertificate
  }
  if (tls?.clientCertPair) {
    nodeOptions.cert = tls.clientCertPair.crt
    nodeOptions.key = tls.clientCertPair.key
  }
  if (tls?.serverNameOverride) {
    nodeOptions.servername = tls.serverNameOverride
  }
  if (useTls && options.allowInsecureTls) {
    nodeOptions.rejectUnauthorized = false
  }

  const metadataRef = new Map<string, string>(Object.entries(options.metadata ?? {}))

  const interceptors: Interceptor[] = [
    (next) => async (request) => {
      for (const [key, value] of metadataRef.entries()) {
        if (!request.header.has(key)) {
          request.header.set(key, value)
        }
      }
      return next(request)
    },
  ]

  if (options.apiKey) {
    interceptors.push((next) => async (request) => {
      if (!request.header.has('authorization')) {
        request.header.set('authorization', `Bearer ${options.apiKey}`)
      }
      return next(request)
    })
  }

  const baseUrl = buildBaseUrl(options.address, useTls)
  const transport = createGrpcTransport({
    baseUrl,
    httpVersion: '2',
    interceptors,
    nodeOptions: Object.keys(nodeOptions).length > 0 ? nodeOptions : undefined,
  })

  // biome-ignore lint/suspicious/noExplicitAny: generated descriptor typing mismatch
  const client = createClient(WorkflowService as any, transport) as unknown as WorkflowServiceSubsetClient

  const setMetadata = (metadata: Record<string, string>): void => {
    metadataRef.clear()
    for (const [key, value] of Object.entries(metadata)) {
      metadataRef.set(key.toLowerCase(), value)
    }
  }

  return { client, setMetadata }
}

export const __TEST_ONLY__ = {
  shouldUseTls,
}
