import type { ClientSessionOptions, SecureClientSessionOptions } from 'node:http2'
import { create, toBinary } from '@bufbuild/protobuf'
import { type CallOptions, Code, ConnectError, createClient, type Transport } from '@connectrpc/connect'
import { createGrpcTransport, type GrpcTransportOptions } from '@connectrpc/connect-node'
import { z } from 'zod'
import { createDefaultHeaders, mergeHeaders } from './client/headers'
import {
  buildCancelRequest,
  buildQueryRequest,
  buildSignalRequest,
  buildSignalWithStartRequest,
  buildStartWorkflowRequest,
  buildTerminateRequest,
  computeSignalRequestId,
  createSignalRequestEntropy,
} from './client/serialization'
import {
  createWorkflowHandle,
  type SignalWithStartOptions,
  type StartWorkflowOptions,
  type StartWorkflowResult,
  type TerminateWorkflowOptions,
  type WorkflowHandle,
  type WorkflowHandleMetadata,
} from './client/types'
import { metadataHeadersSchema } from './client/validation'
import { createDefaultDataConverter, type DataConverter, decodePayloadsToValues } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig, type TLSConfig } from './config'
import type { Payload } from './proto/temporal/api/common/v1/message_pb'
import {
  type DescribeNamespaceRequest,
  DescribeNamespaceRequestSchema,
  DescribeNamespaceResponseSchema,
  type QueryWorkflowResponse,
  type SignalWithStartWorkflowExecutionResponse,
  type StartWorkflowExecutionResponse,
} from './proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from './proto/temporal/api/workflowservice/v1/service_pb'

type ClosableTransport = Transport & { close?: () => void | Promise<void> }
type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

const startWorkflowMetadataSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  namespace: z.string().min(1),
  firstExecutionRunId: z.string().min(1).optional(),
})

const startWorkflowOptionsSchema = z.object({
  workflowId: z.string().min(1),
  workflowType: z.string().min(1),
  args: z.array(z.unknown()).optional(),
  taskQueue: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  identity: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
  memo: z.record(z.unknown()).optional(),
  headers: z.record(z.unknown()).optional(),
  searchAttributes: z.record(z.unknown()).optional(),
  requestId: z.string().min(1).optional(),
  workflowExecutionTimeoutMs: z.number().int().positive().optional(),
  workflowRunTimeoutMs: z.number().int().positive().optional(),
  workflowTaskTimeoutMs: z.number().int().positive().optional(),
  retryPolicy: z
    .object({
      initialIntervalMs: z.number().int().positive().optional(),
      maximumIntervalMs: z.number().int().positive().optional(),
      maximumAttempts: z.number().int().optional(),
      backoffCoefficient: z.number().positive().optional(),
      nonRetryableErrorTypes: z.array(z.string().min(1)).optional(),
    })
    .optional(),
})

const terminateWorkflowOptionsSchema = z.object({
  reason: z.string().optional(),
  details: z.array(z.unknown()).optional(),
  runId: z.string().min(1).optional(),
  firstExecutionRunId: z.string().min(1).optional(),
})

const workflowHandleSchema = z.object({
  workflowId: z.string().min(1),
  namespace: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  firstExecutionRunId: z.string().min(1).optional(),
})

export interface TemporalWorkflowClient {
  start(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signal(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  query(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminate(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancel(handle: WorkflowHandle): Promise<void>
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
}

export interface TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient
  startWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminateWorkflow(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancelWorkflow(handle: WorkflowHandle): Promise<void>
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
  describeNamespace(namespace?: string): Promise<Uint8Array>
  updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void>
  shutdown(): Promise<void>
}

export interface CreateTemporalClientOptions {
  config?: TemporalConfig
  namespace?: string
  identity?: string
  taskQueue?: string
  dataConverter?: DataConverter
}

export const createTemporalClient = async (
  options: CreateTemporalClientOptions = {},
): Promise<{ client: TemporalClient; config: TemporalConfig }> => {
  const config = options.config ?? (await loadTemporalConfig())

  const namespace = options.namespace ?? config.namespace
  const identity = options.identity ?? config.workerIdentity
  const taskQueue = options.taskQueue ?? config.taskQueue
  const dataConverter = options.dataConverter ?? createDefaultDataConverter()
  const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)

  const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
  const transportOptions = buildTransportOptions(baseUrl, config)
  const transport = createGrpcTransport(transportOptions)
  const workflowService = createClient(WorkflowService, transport)

  const initialHeaders = createDefaultHeaders(config.apiKey)

  const client = new TemporalClientImpl({
    transport,
    workflowService,
    config,
    namespace,
    identity,
    taskQueue,
    dataConverter,
    headers: initialHeaders,
  })

  return { client, config }
}

class TemporalClientImpl implements TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient

  private readonly transport: ClosableTransport
  private readonly workflowService: WorkflowServiceClient
  private readonly defaultIdentity: string
  private readonly defaultTaskQueue: string
  private closed = false
  private headers: Record<string, string>

  constructor(handles: {
    transport: ClosableTransport
    workflowService: WorkflowServiceClient
    config: TemporalConfig
    namespace: string
    identity: string
    taskQueue: string
    dataConverter: DataConverter
    headers: Record<string, string>
  }) {
    this.transport = handles.transport
    this.workflowService = handles.workflowService
    this.config = handles.config
    this.namespace = handles.namespace
    this.defaultIdentity = handles.identity
    this.defaultTaskQueue = handles.taskQueue
    this.dataConverter = handles.dataConverter
    this.headers = { ...handles.headers }

    this.workflow = {
      start: (options) => this.startWorkflow(options),
      signal: (handle, signalName, ...args) => this.signalWorkflow(handle, signalName, ...args),
      query: (handle, queryName, ...args) => this.queryWorkflow(handle, queryName, ...args),
      terminate: (handle, options) => this.terminateWorkflow(handle, options),
      cancel: (handle) => this.cancelWorkflow(handle),
      signalWithStart: (options) => this.signalWithStart(options),
    }
  }

  async startWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult> {
    this.ensureOpen()
    const parsedOptions = startWorkflowOptionsSchema.parse(options)

    const request = await buildStartWorkflowRequest(
      {
        options: parsedOptions as StartWorkflowOptions,
        defaults: {
          namespace: this.namespace,
          identity: this.defaultIdentity,
          taskQueue: this.defaultTaskQueue,
        },
      },
      this.dataConverter,
    )

    const response = await this.workflowService.startWorkflowExecution(request, this.callOptions())
    return this.toStartWorkflowResult(response, {
      workflowId: request.workflowId,
      namespace: request.namespace,
      firstExecutionRunId: response.started ? response.runId : undefined,
    })
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void> {
    this.ensureOpen()
    const parsedHandle = workflowHandleSchema.parse(handle)
    const resolvedHandle = resolveHandle(this.namespace, parsedHandle)

    const identity = this.defaultIdentity
    const entropy = createSignalRequestEntropy()
    const requestId = await computeSignalRequestId(
      {
        namespace: resolvedHandle.namespace,
        workflowId: resolvedHandle.workflowId,
        runId: resolvedHandle.runId,
        firstExecutionRunId: resolvedHandle.firstExecutionRunId,
        signalName,
        identity,
        args,
      },
      this.dataConverter,
      { entropy },
    )

    const request = await buildSignalRequest(
      {
        handle: resolvedHandle,
        signalName,
        args,
        identity,
        requestId,
      },
      this.dataConverter,
    )

    await this.workflowService.signalWorkflowExecution(request, this.callOptions())
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown> {
    this.ensureOpen()
    const parsedHandle = workflowHandleSchema.parse(handle)
    const resolvedHandle = resolveHandle(this.namespace, parsedHandle)

    const request = await buildQueryRequest(resolvedHandle, queryName, args, this.dataConverter)
    const response = await this.workflowService.queryWorkflow(request, this.callOptions())

    return this.parseQueryResult(response)
  }

  async terminateWorkflow(handle: WorkflowHandle, options: TerminateWorkflowOptions = {}): Promise<void> {
    this.ensureOpen()
    const parsedHandle = workflowHandleSchema.parse(handle)
    const resolvedHandle = resolveHandle(this.namespace, parsedHandle)
    const parsedOptions = terminateWorkflowOptionsSchema.parse(options)

    const request = await buildTerminateRequest(resolvedHandle, parsedOptions, this.dataConverter, this.defaultIdentity)
    await this.workflowService.terminateWorkflowExecution(request, this.callOptions())
  }

  async cancelWorkflow(handle: WorkflowHandle): Promise<void> {
    this.ensureOpen()
    const parsedHandle = workflowHandleSchema.parse(handle)
    const resolvedHandle = resolveHandle(this.namespace, parsedHandle)

    const request = buildCancelRequest(resolvedHandle, this.defaultIdentity)
    await this.workflowService.requestCancelWorkflowExecution(request, this.callOptions())
  }

  async signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult> {
    this.ensureOpen()
    const parsedOptions = startWorkflowOptionsSchema
      .extend({ signalName: z.string().min(1), signalArgs: z.array(z.unknown()).optional() })
      .parse(options)

    const request = await buildSignalWithStartRequest(
      {
        options: parsedOptions as SignalWithStartOptions,
        defaults: {
          namespace: this.namespace,
          identity: this.defaultIdentity,
          taskQueue: this.defaultTaskQueue,
        },
      },
      this.dataConverter,
    )

    const response = await this.workflowService.signalWithStartWorkflowExecution(request, this.callOptions())
    return this.toStartWorkflowResult(response, {
      workflowId: request.workflowId,
      namespace: request.namespace,
      firstExecutionRunId: response.started ? response.runId : undefined,
    })
  }

  async describeNamespace(targetNamespace?: string): Promise<Uint8Array> {
    this.ensureOpen()
    const request: DescribeNamespaceRequest = create(DescribeNamespaceRequestSchema, {
      namespace: targetNamespace ?? this.namespace,
    })

    const response = await this.workflowService.describeNamespace(request, this.callOptions())
    return toBinary(DescribeNamespaceResponseSchema, response)
  }

  async updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void> {
    if (this.closed) {
      throw new Error('Temporal client has already been shut down')
    }
    const normalized = metadataHeadersSchema.parse(headers)
    this.headers = mergeHeaders(this.headers, normalized)
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const maybeClose = this.transport.close
    if (typeof maybeClose === 'function') {
      await maybeClose.call(this.transport)
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Temporal client has been shut down')
    }
  }

  private callOptions(): CallOptions {
    return {
      headers: { ...this.headers },
    }
  }

  private toStartWorkflowResult(
    response: StartWorkflowExecutionResponse | SignalWithStartWorkflowExecutionResponse,
    metadata: {
      workflowId: string
      namespace: string
      firstExecutionRunId?: string
    },
  ): StartWorkflowResult {
    const parsed = startWorkflowMetadataSchema.parse({
      runId: response.runId,
      workflowId: metadata.workflowId,
      namespace: metadata.namespace,
      firstExecutionRunId: metadata.firstExecutionRunId,
    }) as unknown as WorkflowHandleMetadata

    return {
      ...parsed,
      handle: createWorkflowHandle(parsed),
    }
  }

  private async parseQueryResult(response: QueryWorkflowResponse): Promise<unknown> {
    if (response.queryRejected) {
      throw new ConnectError('Temporal query was rejected', Code.FailedPrecondition, undefined, undefined, {
        message: response.queryRejected.status.toString(),
      })
    }

    const payloads = response.queryResult?.payloads ?? []
    if (!payloads.length) {
      return null
    }

    const [value] = await decodePayloadsToValues(this.dataConverter, payloads as unknown as Payload[])
    return value ?? null
  }
}

const normalizeTemporalAddress = (address: string, useTls: boolean): string => {
  if (/^http(s)?:\/\//i.test(address)) {
    return address
  }
  return `${useTls ? 'https' : 'http'}://${address}`
}

const buildTransportOptions = (baseUrl: string, config: TemporalConfig): GrpcTransportOptions => {
  const nodeOptions: ClientSessionOptions | SecureClientSessionOptions = {}

  if (config.tls) {
    applyTlsConfig(nodeOptions, config.tls)
  }

  if (config.allowInsecureTls) {
    ;(nodeOptions as SecureClientSessionOptions).rejectUnauthorized = false
  }

  return {
    baseUrl,
    nodeOptions,
  }
}

const applyTlsConfig = (options: ClientSessionOptions | SecureClientSessionOptions, tls: TLSConfig): void => {
  const secure = options as SecureClientSessionOptions
  if (tls.serverRootCACertificate) {
    secure.ca = tls.serverRootCACertificate
  }
  if (tls.clientCertPair) {
    secure.cert = tls.clientCertPair.crt
    secure.key = tls.clientCertPair.key
  }
  if (tls.serverNameOverride) {
    secure.servername = tls.serverNameOverride
  }
}

const resolveHandle = (defaultNamespace: string, handle: z.infer<typeof workflowHandleSchema>): WorkflowHandle => ({
  workflowId: handle.workflowId,
  namespace: handle.namespace ?? defaultNamespace,
  runId: handle.runId,
  firstExecutionRunId: handle.firstExecutionRunId,
})

export type {
  SignalWithStartOptions,
  StartWorkflowOptions,
  StartWorkflowResult,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './client/types'
