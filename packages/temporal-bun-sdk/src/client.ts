import type { ClientSessionOptions, SecureClientSessionOptions } from 'node:http2'
import { create, toBinary } from '@bufbuild/protobuf'
import { type CallOptions, Code, ConnectError, createClient, type Transport } from '@connectrpc/connect'
import { createGrpcTransport, type GrpcTransportOptions } from '@connectrpc/connect-node'
import { Effect } from 'effect'
import { createDefaultHeaders, mergeHeaders, normalizeMetadataHeaders } from './client/headers'
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
  type RetryPolicyOptions,
  type SignalWithStartOptions,
  type StartWorkflowOptions,
  type StartWorkflowResult,
  type TerminateWorkflowOptions,
  type WorkflowHandle,
  type WorkflowHandleMetadata,
} from './client/types'
import { createDefaultDataConverter, type DataConverter, decodePayloadsToValues } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig, type TLSConfig } from './config'
import { createObservabilityServices } from './observability'
import type { Logger } from './observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from './observability/metrics'
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

type TemporalClientMetrics = {
  readonly operationCount: Counter
  readonly operationLatency: Histogram
  readonly operationErrors: Counter
}

export interface CreateTemporalClientOptions {
  config?: TemporalConfig
  namespace?: string
  identity?: string
  taskQueue?: string
  dataConverter?: DataConverter
  logger?: Logger
  metrics?: MetricsRegistry
  metricsExporter?: MetricsExporter
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
  const observability = await Effect.runPromise(
    createObservabilityServices(
      {
        logLevel: config.logLevel,
        logFormat: config.logFormat,
        metrics: config.metricsExporter,
      },
      {
        logger: options.logger,
        metricsRegistry: options.metrics,
        metricsExporter: options.metricsExporter,
      },
    ),
  )
  const { logger, metricsRegistry, metricsExporter } = observability
  const clientMetrics = await TemporalClientImpl.initMetrics(metricsRegistry)

  const client = new TemporalClientImpl({
    transport,
    workflowService,
    config,
    namespace,
    identity,
    taskQueue,
    dataConverter,
    headers: initialHeaders,
    logger,
    metrics: clientMetrics,
    metricsExporter,
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
  #logger: Logger
  #clientMetrics: TemporalClientMetrics
  #metricsExporter: MetricsExporter
  private closed = false
  private headers: Record<string, string>

  static async initMetrics(registry: MetricsRegistry): Promise<TemporalClientMetrics> {
    const makeCounter = (name: string, description: string) => Effect.runPromise(registry.counter(name, description))
    const makeHistogram = (name: string, description: string) =>
      Effect.runPromise(registry.histogram(name, description))
    return {
      operationCount: await makeCounter('temporal_client_operations_total', 'Temporal client operation calls'),
      operationLatency: await makeHistogram(
        'temporal_client_operation_latency_ms',
        'Latency for Temporal client operations',
      ),
      operationErrors: await makeCounter('temporal_client_operation_errors_total', 'Temporal client operation errors'),
    }
  }

  constructor(handles: {
    transport: ClosableTransport
    workflowService: WorkflowServiceClient
    config: TemporalConfig
    namespace: string
    identity: string
    taskQueue: string
    dataConverter: DataConverter
    headers: Record<string, string>
    logger: Logger
    metrics: TemporalClientMetrics
    metricsExporter: MetricsExporter
  }) {
    this.transport = handles.transport
    this.workflowService = handles.workflowService
    this.config = handles.config
    this.namespace = handles.namespace
    this.defaultIdentity = handles.identity
    this.defaultTaskQueue = handles.taskQueue
    this.dataConverter = handles.dataConverter
    this.headers = { ...handles.headers }
    this.#logger = handles.logger
    this.#clientMetrics = handles.metrics
    this.#metricsExporter = handles.metricsExporter

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
    return this.#instrumentOperation('startWorkflow', async () => {
      this.ensureOpen()
      const parsedOptions = sanitizeStartWorkflowOptions(options)

      const request = await buildStartWorkflowRequest(
        {
          options: parsedOptions,
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
    })
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void> {
    return this.#instrumentOperation('signalWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)
      const normalizedSignalName = ensureNonEmptyString(signalName, 'signalName')

      const identity = this.defaultIdentity
      const entropy = createSignalRequestEntropy()
      const requestId = await computeSignalRequestId(
        {
          namespace: resolvedHandle.namespace,
          workflowId: resolvedHandle.workflowId,
          runId: resolvedHandle.runId,
          firstExecutionRunId: resolvedHandle.firstExecutionRunId,
          signalName: normalizedSignalName,
          identity,
          args,
        },
        this.dataConverter,
        { entropy },
      )

      const request = await buildSignalRequest(
        {
          handle: resolvedHandle,
          signalName: normalizedSignalName,
          args,
          identity,
          requestId,
        },
        this.dataConverter,
      )

      await this.workflowService.signalWorkflowExecution(request, this.callOptions())
    })
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown> {
    return this.#instrumentOperation('queryWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)

      const request = await buildQueryRequest(resolvedHandle, queryName, args, this.dataConverter)
      const response = await this.workflowService.queryWorkflow(request, this.callOptions())

      return this.parseQueryResult(response)
    })
  }

  async terminateWorkflow(handle: WorkflowHandle, options: TerminateWorkflowOptions = {}): Promise<void> {
    return this.#instrumentOperation('terminateWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)
      const parsedOptions = sanitizeTerminateWorkflowOptions(options)

      const request = await buildTerminateRequest(
        resolvedHandle,
        parsedOptions,
        this.dataConverter,
        this.defaultIdentity,
      )
      await this.workflowService.terminateWorkflowExecution(request, this.callOptions())
    })
  }

  async cancelWorkflow(handle: WorkflowHandle): Promise<void> {
    return this.#instrumentOperation('cancelWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)

      const request = buildCancelRequest(resolvedHandle, this.defaultIdentity)
      await this.workflowService.requestCancelWorkflowExecution(request, this.callOptions())
    })
  }

  async signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult> {
    return this.#instrumentOperation('signalWithStart', async () => {
      this.ensureOpen()
      const startOptions = sanitizeStartWorkflowOptions(options)
      const signalName = ensureNonEmptyString(options.signalName, 'signalName')
      const signalArgs = options.signalArgs ?? []
      if (!Array.isArray(signalArgs)) {
        throw new Error('signalArgs must be an array when provided')
      }

      const request = await buildSignalWithStartRequest(
        {
          options: {
            ...startOptions,
            signalName,
            signalArgs,
          },
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
    })
  }

  async describeNamespace(targetNamespace?: string): Promise<Uint8Array> {
    return this.#instrumentOperation('describeNamespace', async () => {
      this.ensureOpen()
      const request: DescribeNamespaceRequest = create(DescribeNamespaceRequestSchema, {
        namespace: targetNamespace ?? this.namespace,
      })

      const response = await this.workflowService.describeNamespace(request, this.callOptions())
      return toBinary(DescribeNamespaceResponseSchema, response)
    })
  }

  async updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void> {
    if (this.closed) {
      throw new Error('Temporal client has already been shut down')
    }
    const normalized = normalizeMetadataHeaders(headers)
    this.headers = mergeHeaders(this.headers, normalized)
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const maybeClose = this.transport.close
    if (typeof maybeClose === 'function') {
      await maybeClose.call(this.transport)
    }
    await this.#flushMetrics()
  }

  async #flushMetrics(): Promise<void> {
    try {
      await Effect.runPromise(this.#metricsExporter.flush())
    } catch (error) {
      await Effect.runPromise(
        this.#logger.log('warn', 'failed to flush client metrics exporter', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  #recordMetrics(durationMs: number, failed: boolean): void {
    void Effect.runPromise(this.#clientMetrics.operationCount.inc())
    void Effect.runPromise(this.#clientMetrics.operationLatency.observe(durationMs))
    if (failed) {
      void Effect.runPromise(this.#clientMetrics.operationErrors.inc())
    }
  }

  async #instrumentOperation<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const start = Date.now()
    try {
      const result = await action()
      await Effect.runPromise(
        this.#logger.log('debug', `temporal client ${operation} succeeded`, {
          operation,
          namespace: this.namespace,
        }),
      )
      this.#recordMetrics(Date.now() - start, false)
      return result
    } catch (error) {
      await Effect.runPromise(
        this.#logger.log('error', `temporal client ${operation} failed`, {
          operation,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      this.#recordMetrics(Date.now() - start, true)
      throw error
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
    const runId = ensureNonEmptyString(response.runId, 'runId')
    const workflowId = ensureNonEmptyString(metadata.workflowId, 'workflowId')
    const namespace = ensureNonEmptyString(metadata.namespace, 'namespace')
    const firstExecutionRunId = metadata.firstExecutionRunId
      ? ensureNonEmptyString(metadata.firstExecutionRunId, 'firstExecutionRunId')
      : undefined

    const parsed: WorkflowHandleMetadata = {
      runId,
      workflowId,
      namespace,
      firstExecutionRunId,
    }

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

export const normalizeTemporalAddress = (address: string, useTls: boolean): string => {
  if (/^http(s)?:\/\//i.test(address)) {
    return address
  }
  return `${useTls ? 'https' : 'http'}://${address}`
}

export const buildTransportOptions = (baseUrl: string, config: TemporalConfig): GrpcTransportOptions => {
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
    defaultTimeoutMs: 60_000,
  }
}

export const applyTlsConfig = (options: ClientSessionOptions | SecureClientSessionOptions, tls: TLSConfig): void => {
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

const ensureOptionalTrimmedString = (value: string | undefined, field: string, minLength = 0): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length < minLength) {
    throw new Error(`${field} must be at least ${minLength} characters`)
  }
  return trimmed
}

const ensureNonEmptyString = (value: string | undefined, field: string): string => {
  const trimmed = ensureOptionalTrimmedString(value, field, 1)
  if (trimmed === undefined) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return trimmed
}

const ensureOptionalPositiveInteger = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

const ensureOptionalInteger = (
  value: number | undefined,
  field: string,
  minimum = Number.MIN_SAFE_INTEGER,
): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

const ensureOptionalPositiveNumber = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`)
  }
  return value
}

const sanitizeRetryPolicy = (policy?: RetryPolicyOptions): RetryPolicyOptions | undefined => {
  if (!policy) {
    return undefined
  }

  const sanitized: RetryPolicyOptions = {}

  sanitized.initialIntervalMs = ensureOptionalPositiveInteger(policy.initialIntervalMs, 'retryPolicy.initialIntervalMs')
  sanitized.maximumIntervalMs = ensureOptionalPositiveInteger(policy.maximumIntervalMs, 'retryPolicy.maximumIntervalMs')
  sanitized.maximumAttempts = ensureOptionalInteger(policy.maximumAttempts, 'retryPolicy.maximumAttempts', 0)
  sanitized.backoffCoefficient = ensureOptionalPositiveNumber(
    policy.backoffCoefficient,
    'retryPolicy.backoffCoefficient',
  )

  if (policy.nonRetryableErrorTypes !== undefined) {
    if (!Array.isArray(policy.nonRetryableErrorTypes)) {
      throw new Error('retryPolicy.nonRetryableErrorTypes must be an array when provided')
    }
    sanitized.nonRetryableErrorTypes = policy.nonRetryableErrorTypes.map((type, index) =>
      ensureNonEmptyString(type, `retryPolicy.nonRetryableErrorTypes[${index}]`),
    )
  }

  return sanitized
}

const sanitizeStartWorkflowOptions = (options: StartWorkflowOptions): StartWorkflowOptions => {
  const sanitized: StartWorkflowOptions = {
    ...options,
    workflowId: ensureNonEmptyString(options.workflowId, 'workflowId'),
    workflowType: ensureNonEmptyString(options.workflowType, 'workflowType'),
  }

  sanitized.taskQueue = ensureOptionalTrimmedString(options.taskQueue, 'taskQueue', 1)
  sanitized.namespace = ensureOptionalTrimmedString(options.namespace, 'namespace', 1)
  sanitized.identity = ensureOptionalTrimmedString(options.identity, 'identity', 1)
  sanitized.cronSchedule = ensureOptionalTrimmedString(options.cronSchedule, 'cronSchedule', 1)
  sanitized.requestId = ensureOptionalTrimmedString(options.requestId, 'requestId', 1)

  sanitized.workflowExecutionTimeoutMs = ensureOptionalPositiveInteger(
    options.workflowExecutionTimeoutMs,
    'workflowExecutionTimeoutMs',
  )
  sanitized.workflowRunTimeoutMs = ensureOptionalPositiveInteger(options.workflowRunTimeoutMs, 'workflowRunTimeoutMs')
  sanitized.workflowTaskTimeoutMs = ensureOptionalPositiveInteger(
    options.workflowTaskTimeoutMs,
    'workflowTaskTimeoutMs',
  )

  sanitized.retryPolicy = sanitizeRetryPolicy(options.retryPolicy)

  return sanitized
}

const sanitizeTerminateWorkflowOptions = (options: TerminateWorkflowOptions = {}): TerminateWorkflowOptions => {
  if (options.details !== undefined && !Array.isArray(options.details)) {
    throw new Error('details must be an array when provided')
  }

  return {
    ...options,
    reason: options.reason === undefined ? undefined : options.reason.trim(),
    runId: ensureOptionalTrimmedString(options.runId, 'runId', 1),
    firstExecutionRunId: ensureOptionalTrimmedString(options.firstExecutionRunId, 'firstExecutionRunId', 1),
  }
}

const resolveHandle = (defaultNamespace: string, handle: WorkflowHandle): WorkflowHandle => {
  const workflowId = ensureNonEmptyString(handle.workflowId, 'workflowId')
  const namespace = ensureOptionalTrimmedString(handle.namespace, 'namespace', 1) ?? defaultNamespace
  const runId = ensureOptionalTrimmedString(handle.runId, 'runId', 1)
  const firstExecutionRunId = ensureOptionalTrimmedString(handle.firstExecutionRunId, 'firstExecutionRunId', 1)

  return {
    workflowId,
    namespace,
    runId,
    firstExecutionRunId,
  }
}

export type {
  SignalWithStartOptions,
  StartWorkflowOptions,
  StartWorkflowResult,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './client/types'
