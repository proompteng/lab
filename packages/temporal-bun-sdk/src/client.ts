import type { ClientSessionOptions, SecureClientSessionOptions } from 'node:http2'
import { performance } from 'node:perf_hooks'
import { create, toBinary } from '@bufbuild/protobuf'
import { type CallOptions, Code, ConnectError, createClient, type Transport } from '@connectrpc/connect'
import { createGrpcTransport, type GrpcTransportOptions } from '@connectrpc/connect-node'
import { metrics as otelMetrics } from '@opentelemetry/api'
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
import { createLogger, type Logger, type LogLevel } from './observability/logger'
import {
  type Counter,
  type Histogram,
  type MetricAttributes,
  type MetricsRegistry,
  makeInMemoryMetrics,
  makeOpenTelemetryMetrics,
} from './observability/metrics'
import type { Span } from './observability/tracing'
import { makeNoopTracer, makeOpenTelemetryTracer, type Tracer } from './observability/tracing'
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

interface ClientMetricsHandles {
  readonly rpcLatency: Histogram
  readonly rpcFailures: Counter
}

const resolveMetricsRegistry = async (
  metricsConfig: TemporalConfig['observability']['metrics'],
  override?: MetricsRegistry,
): Promise<MetricsRegistry> => {
  if (override) {
    return override
  }
  if (metricsConfig.exporter === 'otel') {
    const meter =
      metricsConfig.meter ??
      otelMetrics.getMeter(metricsConfig.meterName ?? 'temporal-bun-sdk', metricsConfig.meterVersion, {
        schemaUrl: metricsConfig.schemaUrl,
      })
    return makeOpenTelemetryMetrics(meter)
  }
  return await Effect.runPromise(makeInMemoryMetrics())
}

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
  logger?: Logger
  metrics?: MetricsRegistry
  tracer?: Tracer
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

  const observability = config.observability
  const baseLogger =
    options.logger ??
    createLogger({
      level: observability.logger.level,
      format: observability.logger.format,
    })
  const logger = baseLogger.with({
    component: 'temporal-client',
    namespace,
    identity,
    taskQueue,
  })

  const metricsRegistry = await resolveMetricsRegistry(observability.metrics, options.metrics)
  const metricsHandles = await createClientMetrics(metricsRegistry)
  const metricBaseAttributes: MetricAttributes = {
    namespace,
    identity,
    task_queue: taskQueue,
  }

  const tracer =
    options.tracer ??
    (observability.tracing.enabled && observability.tracing.exporter === 'otel'
      ? makeOpenTelemetryTracer({ serviceName: observability.tracing.serviceName })
      : makeNoopTracer())

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
    metricsHandles,
    metricBaseAttributes,
    tracer,
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
  private readonly logger: Logger
  private readonly metricsHandles: ClientMetricsHandles
  private readonly metricBaseAttributes: MetricAttributes
  private readonly tracer: Tracer
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
    logger: Logger
    metricsHandles: ClientMetricsHandles
    metricBaseAttributes: MetricAttributes
    tracer: Tracer
  }) {
    this.transport = handles.transport
    this.workflowService = handles.workflowService
    this.config = handles.config
    this.namespace = handles.namespace
    this.defaultIdentity = handles.identity
    this.defaultTaskQueue = handles.taskQueue
    this.dataConverter = handles.dataConverter
    this.headers = { ...handles.headers }
    this.logger = handles.logger
    this.metricsHandles = handles.metricsHandles
    this.metricBaseAttributes = handles.metricBaseAttributes
    this.tracer = handles.tracer

    this.workflow = {
      start: (options) => this.startWorkflow(options),
      signal: (handle, signalName, ...args) => this.signalWorkflow(handle, signalName, ...args),
      query: (handle, queryName, ...args) => this.queryWorkflow(handle, queryName, ...args),
      terminate: (handle, options) => this.terminateWorkflow(handle, options),
      cancel: (handle) => this.cancelWorkflow(handle),
      signalWithStart: (options) => this.signalWithStart(options),
    }
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    Effect.runFork(this.logger.log(level, message, fields))
  }

  private logDebug(message: string, fields?: Record<string, unknown>) {
    this.log('debug', message, fields)
  }

  private logError(message: string, fields?: Record<string, unknown>) {
    this.log('error', message, fields)
  }

  private recordMetric(effect: Effect.Effect<void, never, never>) {
    Effect.runFork(effect)
  }

  private attributes(extra?: MetricAttributes): MetricAttributes {
    if (!extra || Object.keys(extra).length === 0) {
      return { ...this.metricBaseAttributes }
    }
    return { ...this.metricBaseAttributes, ...extra }
  }

  private recordRpcLatency(method: string, durationMs: number) {
    this.recordMetric(this.metricsHandles.rpcLatency.observe(durationMs, this.attributes({ rpc_method: method })))
  }

  private recordRpcFailure(method: string, error: unknown) {
    const info = this.extractErrorInfo(error)
    this.recordMetric(this.metricsHandles.rpcFailures.inc(1, this.attributes({ rpc_method: method, code: info.code })))
  }

  private startSpan(name: string, attributes?: MetricAttributes): Span {
    return this.tracer.startSpan(name, this.attributes(attributes))
  }

  private extractErrorInfo(error: unknown): { code: string } {
    if (error instanceof ConnectError) {
      const codeName = Code[error.code]
      return { code: typeof codeName === 'string' ? codeName : String(error.code) }
    }
    if (error instanceof Error) {
      return { code: error.name }
    }
    return { code: 'unknown' }
  }

  private async withRpc<T>(method: string, attributes: MetricAttributes, invoke: () => Promise<T>): Promise<T> {
    const rpcAttributes = this.attributes({ ...attributes, rpc_method: method })
    this.logDebug('temporal client rpc request', rpcAttributes)
    const span = this.startSpan(`temporal.client.${method}`, rpcAttributes)
    const started = performance.now()
    try {
      const result = await invoke()
      const duration = performance.now() - started
      this.recordRpcLatency(method, duration)
      this.logDebug('temporal client rpc success', { ...rpcAttributes, durationMs: duration })
      span.end()
      return result
    } catch (error) {
      const duration = performance.now() - started
      this.recordRpcLatency(method, duration)
      this.recordRpcFailure(method, error)
      this.logError('temporal client rpc failure', {
        ...rpcAttributes,
        durationMs: duration,
        ...toErrorFields(error),
      })
      span.recordException(error)
      span.end()
      throw error
    }
  }

  async startWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult> {
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

    const rpcAttributes: Record<string, string | number | boolean> = {
      workflow_id: request.workflowId,
      task_queue: request.taskQueue?.name ?? this.defaultTaskQueue,
    }
    if (request.workflowType?.name) {
      rpcAttributes.workflow_type = request.workflowType.name
    }

    const response = await this.withRpc(
      'StartWorkflowExecution',
      rpcAttributes as MetricAttributes,
      async () => await this.workflowService.startWorkflowExecution(request, this.callOptions()),
    )
    return this.toStartWorkflowResult(response, {
      workflowId: request.workflowId,
      namespace: request.namespace,
      firstExecutionRunId: response.started ? response.runId : undefined,
    })
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void> {
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

    const rpcAttributes: Record<string, string | number | boolean> = {
      workflow_id: resolvedHandle.workflowId,
      signal_name: normalizedSignalName,
    }
    if (resolvedHandle.runId) {
      rpcAttributes.run_id = resolvedHandle.runId
    }

    await this.withRpc(
      'SignalWorkflowExecution',
      rpcAttributes as MetricAttributes,
      async () => await this.workflowService.signalWorkflowExecution(request, this.callOptions()),
    )
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)

    const normalizedQueryName = ensureNonEmptyString(queryName, 'queryName')
    const request = await buildQueryRequest(resolvedHandle, normalizedQueryName, args, this.dataConverter)

    const rpcAttributes: Record<string, string | number | boolean> = {
      workflow_id: resolvedHandle.workflowId,
      query_name: normalizedQueryName,
    }
    if (resolvedHandle.runId) {
      rpcAttributes.run_id = resolvedHandle.runId
    }

    const response = await this.withRpc(
      'QueryWorkflow',
      rpcAttributes as MetricAttributes,
      async () => await this.workflowService.queryWorkflow(request, this.callOptions()),
    )

    return this.parseQueryResult(response)
  }

  async terminateWorkflow(handle: WorkflowHandle, options: TerminateWorkflowOptions = {}): Promise<void> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const parsedOptions = sanitizeTerminateWorkflowOptions(options)

    const request = await buildTerminateRequest(resolvedHandle, parsedOptions, this.dataConverter, this.defaultIdentity)
    const rpcAttributes: Record<string, string | number | boolean> = {
      workflow_id: resolvedHandle.workflowId,
    }
    if (resolvedHandle.runId) {
      rpcAttributes.run_id = resolvedHandle.runId
    }
    if (parsedOptions.reason) {
      rpcAttributes.reason = parsedOptions.reason
    }

    await this.withRpc(
      'TerminateWorkflowExecution',
      rpcAttributes as MetricAttributes,
      async () => await this.workflowService.terminateWorkflowExecution(request, this.callOptions()),
    )
  }

  async cancelWorkflow(handle: WorkflowHandle): Promise<void> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)

    const request = buildCancelRequest(resolvedHandle, this.defaultIdentity)
    const rpcAttributes: Record<string, string | number | boolean> = {
      workflow_id: resolvedHandle.workflowId,
    }
    if (resolvedHandle.runId) {
      rpcAttributes.run_id = resolvedHandle.runId
    }

    await this.withRpc(
      'RequestCancelWorkflowExecution',
      rpcAttributes as MetricAttributes,
      async () => await this.workflowService.requestCancelWorkflowExecution(request, this.callOptions()),
    )
  }

  async signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult> {
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

    const rpcAttributes: Record<string, string | number | boolean> = {
      workflow_id: request.workflowId,
      signal_name: signalName,
      task_queue: request.taskQueue?.name ?? this.defaultTaskQueue,
    }
    if (request.workflowType?.name) {
      rpcAttributes.workflow_type = request.workflowType.name
    }

    const response = await this.withRpc(
      'SignalWithStartWorkflowExecution',
      rpcAttributes as MetricAttributes,
      async () => await this.workflowService.signalWithStartWorkflowExecution(request, this.callOptions()),
    )
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

    const response = await this.withRpc(
      'DescribeNamespace',
      { namespace: request.namespace } as MetricAttributes,
      async () => await this.workflowService.describeNamespace(request, this.callOptions()),
    )
    return toBinary(DescribeNamespaceResponseSchema, response)
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

const toErrorFields = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    }
  }
  return {
    errorMessage: String(error),
  }
}

const createClientMetrics = async (metrics: MetricsRegistry): Promise<ClientMetricsHandles> => {
  const [rpcLatency, rpcFailures] = await Promise.all([
    Effect.runPromise(
      metrics.histogram('temporal_client_rpc_latency_ms', {
        description: 'Latency of Temporal service RPCs invoked by the Temporal client (milliseconds).',
        unit: 'ms',
      }),
    ),
    Effect.runPromise(
      metrics.counter('temporal_client_rpc_failures_total', {
        description: 'Number of Temporal client RPC failures grouped by RPC method and error code.',
      }),
    ),
  ])

  return {
    rpcLatency,
    rpcFailures,
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
