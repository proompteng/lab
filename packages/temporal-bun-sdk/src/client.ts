import { create, toBinary } from '@bufbuild/protobuf'
import { type CallOptions, Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Context, Effect } from 'effect'
import * as Option from 'effect/Option'

import { createDefaultHeaders, mergeHeaders, normalizeMetadataHeaders } from './client/headers'
import { type InterceptorBuilder, makeDefaultInterceptorBuilder, type TemporalInterceptor } from './client/interceptors'
import { type TemporalRpcRetryPolicy, withTemporalRetry } from './client/retries'
import {
  buildCancelRequest,
  buildQueryRequest,
  buildSignalRequest,
  buildSignalWithStartRequest,
  buildStartWorkflowRequest,
  buildTerminateRequest,
  computeSignalRequestId,
  createSignalRequestEntropy,
  decodeMemoAttributes,
  decodeSearchAttributes,
  encodeMemoAttributes,
  encodeSearchAttributes,
} from './client/serialization'
import { buildTransportOptions, type ClosableTransport, normalizeTemporalAddress } from './client/transport'
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
import { loadTemporalConfig, type TemporalConfig } from './config'
import { createObservabilityServices } from './observability'
import type { LogFields, Logger, LogLevel } from './observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from './observability/metrics'
import type { Memo, Payload, SearchAttributes } from './proto/temporal/api/common/v1/message_pb'
import {
  type DescribeNamespaceRequest,
  DescribeNamespaceRequestSchema,
  DescribeNamespaceResponseSchema,
  type QueryWorkflowResponse,
  type SignalWithStartWorkflowExecutionResponse,
  type StartWorkflowExecutionResponse,
} from './proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from './proto/temporal/api/workflowservice/v1/service_pb'
import {
  LoggerService,
  MetricsExporterService,
  MetricsService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from './runtime/effect-layers'

type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

export interface TemporalClientCallOptions {
  readonly headers?: Record<string, string | ArrayBuffer | ArrayBufferView>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly retryPolicy?: Partial<TemporalRpcRetryPolicy>
}

export type BrandedTemporalClientCallOptions = TemporalClientCallOptions & CallOptionsMarker

export const temporalCallOptions = (options: TemporalClientCallOptions): BrandedTemporalClientCallOptions => {
  const copy = { ...options } as BrandedTemporalClientCallOptions & { __temporalCallOptions?: true }
  Object.defineProperty(copy, CALL_OPTIONS_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
  })
  Object.defineProperty(copy, '__temporalCallOptions', {
    value: true,
    enumerable: false,
    configurable: false,
  })
  return copy
}

export interface TemporalMemoHelpers {
  encode(input?: Record<string, unknown>): Promise<Memo | undefined>
  decode(memo?: Memo | null): Promise<Record<string, unknown> | undefined>
}

export interface TemporalSearchAttributeHelpers {
  encode(input?: Record<string, unknown>): Promise<SearchAttributes | undefined>
  decode(attributes?: SearchAttributes | null): Promise<Record<string, unknown> | undefined>
}

const DEFAULT_TLS_SUGGESTIONS = [
  'Verify TEMPORAL_TLS_CA_PATH, CERT_PATH, and KEY_PATH point to valid PEM files',
  'Ensure TEMPORAL_TLS_SERVER_NAME matches the certificate Subject Alternative Name',
  'Set TEMPORAL_ALLOW_INSECURE=1 only for trusted development clusters',
] as const

export class TemporalTlsHandshakeError extends Error {
  override readonly cause?: unknown
  readonly suggestions: readonly string[]

  constructor(message: string, options: { cause?: unknown; suggestions?: readonly string[] } = {}) {
    super(message)
    this.name = 'TemporalTlsHandshakeError'
    this.cause = options.cause
    this.suggestions = options.suggestions ?? DEFAULT_TLS_SUGGESTIONS
  }
}

export interface TemporalWorkflowClient {
  start(options: StartWorkflowOptions, callOptions?: BrandedTemporalClientCallOptions): Promise<StartWorkflowResult>
  signal(
    handle: WorkflowHandle,
    signalName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<void>
  query(
    handle: WorkflowHandle,
    queryName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<unknown>
  terminate(
    handle: WorkflowHandle,
    options?: TerminateWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void>
  cancel(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void>
  signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult>
}

export interface TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient
  readonly memo: TemporalMemoHelpers
  readonly searchAttributes: TemporalSearchAttributeHelpers
  startWorkflow(
    options: StartWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult>
  signalWorkflow(
    handle: WorkflowHandle,
    signalName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<void>
  queryWorkflow(
    handle: WorkflowHandle,
    queryName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<unknown>
  terminateWorkflow(
    handle: WorkflowHandle,
    options?: TerminateWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void>
  cancelWorkflow(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void>
  signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult>
  describeNamespace(namespace?: string, callOptions?: BrandedTemporalClientCallOptions): Promise<Uint8Array>
  updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void>
  shutdown(): Promise<void>
}

type TemporalClientMetrics = {
  readonly operationCount: Counter
  readonly operationLatency: Histogram
  readonly operationErrors: Counter
}

const CALL_OPTIONS_MARKER = Symbol.for('temporal.bun.callOptions')

type CallOptionsMarker = {
  readonly [CALL_OPTIONS_MARKER]: true
}

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const TLS_ERROR_CODE_PREFIXES = ['ERR_TLS_', 'ERR_SSL_']
const TLS_ERROR_MESSAGE_HINTS = [/handshake/i, /certificate/i, /secure tls/i, /ssl/i]

const isCallOptionsCandidate = (value: unknown): value is BrandedTemporalClientCallOptions => {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (CALL_OPTIONS_MARKER in (value as Record<string | symbol, unknown>)) {
    return true
  }
  return (value as Record<string, unknown>).__temporalCallOptions === true
}

const unwrapTlsCause = (error: unknown): Error | undefined => {
  if (error instanceof TemporalTlsHandshakeError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof ConnectError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof Error) {
    return error
  }
  return undefined
}

const wrapRpcError = (error: unknown): unknown => {
  const cause = unwrapTlsCause(error)
  if (!cause) {
    return error
  }
  const code = (cause as NodeJS.ErrnoException).code
  if (typeof code === 'string' && TLS_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return new TemporalTlsHandshakeError(`Temporal TLS handshake failed (${code})`, { cause })
  }
  if (cause.message?.toLowerCase().includes('h2 is not supported')) {
    return new TemporalTlsHandshakeError('Temporal endpoint rejected TLS/HTTP2 handshakes', { cause })
  }
  if (TLS_ERROR_MESSAGE_HINTS.some((pattern) => pattern.test(cause.message))) {
    return new TemporalTlsHandshakeError('Temporal TLS handshake failed', { cause })
  }
  return error
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
  interceptors?: TemporalInterceptor[]
  interceptorBuilder?: InterceptorBuilder
  workflowService?: WorkflowServiceClient
}

export const createTemporalClient = async (
  options: CreateTemporalClientOptions = {},
): Promise<{ client: TemporalClient; config: TemporalConfig }> => {
  const config = options.config ?? (await loadTemporalConfig())
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
  const interceptorBuilder = options.interceptorBuilder ?? makeDefaultInterceptorBuilder()
  const defaultInterceptors = await Effect.runPromise(
    interceptorBuilder.build({
      namespace: options.namespace ?? config.namespace,
      identity: options.identity ?? config.workerIdentity,
      logger,
      metricsRegistry,
      metricsExporter,
    }),
  )
  const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
  const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
  const allInterceptors = [...defaultInterceptors, ...(options.interceptors ?? [])]
  const transportOptions = buildTransportOptions(baseUrl, config, allInterceptors)
  const transport = createGrpcTransport(transportOptions) as ClosableTransport
  const workflowService = createClient(WorkflowService, transport)

  const effect = makeTemporalClientEffect({
    ...options,
    config,
    logger,
    metrics: metricsRegistry,
    metricsExporter,
    workflowService,
  })

  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(TemporalConfigService, config),
      Effect.provideService(LoggerService, logger),
      Effect.provideService(MetricsService, metricsRegistry),
      Effect.provideService(MetricsExporterService, metricsExporter),
      Effect.provideService(WorkflowServiceClientService, workflowService),
    ),
  )
}

export const makeTemporalClientEffect = (
  options: CreateTemporalClientOptions = {},
): Effect.Effect<
  { client: TemporalClient; config: TemporalConfig },
  unknown,
  TemporalConfigService | LoggerService | MetricsService | MetricsExporterService | WorkflowServiceClientService
> =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* TemporalConfigService)
    const namespace = options.namespace ?? config.namespace
    const identity = options.identity ?? config.workerIdentity
    const taskQueue = options.taskQueue ?? config.taskQueue
    const dataConverter = options.dataConverter ?? createDefaultDataConverter()
    const initialHeaders = createDefaultHeaders(config.apiKey)
    const logger = options.logger ?? (yield* LoggerService)
    const metricsRegistry = options.metrics ?? (yield* MetricsService)
    const metricsExporter = options.metricsExporter ?? (yield* MetricsExporterService)
    const workflowServiceFromContext = yield* Effect.contextWith((context) =>
      Context.getOption(context, WorkflowServiceClientService),
    )
    let workflowService = options.workflowService ?? Option.getOrUndefined(workflowServiceFromContext)
    let transport: ClosableTransport | undefined

    if (!workflowService) {
      const interceptorBuilder = options.interceptorBuilder ?? makeDefaultInterceptorBuilder()
      const defaultInterceptors = yield* interceptorBuilder.build({
        namespace,
        identity,
        logger,
        metricsRegistry,
        metricsExporter,
      })
      const allInterceptors = [...defaultInterceptors, ...(options.interceptors ?? [])]
      const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
      const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
      const transportOptions = buildTransportOptions(baseUrl, config, allInterceptors)
      transport = createGrpcTransport(transportOptions) as ClosableTransport
      workflowService = createClient(WorkflowService, transport)
    }

    const clientMetrics = yield* Effect.promise(() => TemporalClientImpl.initMetrics(metricsRegistry))
    if (!workflowService) {
      throw new Error('Temporal workflow service is not available')
    }

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
  }) as Effect.Effect<
    { client: TemporalClient; config: TemporalConfig },
    unknown,
    TemporalConfigService | LoggerService | MetricsService | MetricsExporterService | WorkflowServiceClientService
  >

class TemporalClientImpl implements TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient
  readonly memo: TemporalMemoHelpers
  readonly searchAttributes: TemporalSearchAttributeHelpers

  private readonly transport?: ClosableTransport
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
    transport?: ClosableTransport
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
    this.memo = {
      encode: (input) => encodeMemoAttributes(this.dataConverter, input),
      decode: (memo) => decodeMemoAttributes(this.dataConverter, memo),
    }
    this.searchAttributes = {
      encode: (input) => encodeSearchAttributes(this.dataConverter, input),
      decode: (attributes) => decodeSearchAttributes(this.dataConverter, attributes),
    }

    this.workflow = {
      start: (options, callOptions) => this.startWorkflow(options, callOptions),
      signal: (handle, signalName, ...args) => this.signalWorkflow(handle, signalName, ...args),
      query: (handle, queryName, ...args) => this.queryWorkflow(handle, queryName, ...args),
      terminate: (handle, options, callOptions) => this.terminateWorkflow(handle, options, callOptions),
      cancel: (handle, callOptions) => this.cancelWorkflow(handle, callOptions),
      signalWithStart: (options, callOptions) => this.signalWithStart(options, callOptions),
    }
  }

  async startWorkflow(
    options: StartWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult> {
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

      const response = await this.executeRpc(
        'startWorkflow',
        (rpcOptions) => this.workflowService.startWorkflowExecution(request, rpcOptions),
        callOptions,
      )
      return this.toStartWorkflowResult(response, {
        workflowId: request.workflowId,
        namespace: request.namespace,
        firstExecutionRunId: response.started ? response.runId : undefined,
      })
    })
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...rawArgs: unknown[]): Promise<void> {
    return this.#instrumentOperation('signalWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)
      const normalizedSignalName = ensureNonEmptyString(signalName, 'signalName')
      const { values, callOptions } = this.#splitArgsAndOptions(rawArgs)

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
          args: values,
        },
        this.dataConverter,
        { entropy },
      )

      const request = await buildSignalRequest(
        {
          handle: resolvedHandle,
          signalName: normalizedSignalName,
          args: values,
          identity,
          requestId,
        },
        this.dataConverter,
      )

      await this.executeRpc(
        'signalWorkflow',
        (rpcOptions) => this.workflowService.signalWorkflowExecution(request, rpcOptions),
        callOptions,
      )
    })
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...rawArgs: unknown[]): Promise<unknown> {
    return this.#instrumentOperation('queryWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)
      const { values, callOptions } = this.#splitArgsAndOptions(rawArgs)

      const request = await buildQueryRequest(resolvedHandle, queryName, values, this.dataConverter)
      const response = await this.executeRpc(
        'queryWorkflow',
        (rpcOptions) => this.workflowService.queryWorkflow(request, rpcOptions),
        callOptions,
      )

      return this.parseQueryResult(response)
    })
  }

  async terminateWorkflow(
    handle: WorkflowHandle,
    options: TerminateWorkflowOptions = {},
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void> {
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
      await this.executeRpc(
        'terminateWorkflow',
        (rpcOptions) => this.workflowService.terminateWorkflowExecution(request, rpcOptions),
        callOptions,
      )
    })
  }

  async cancelWorkflow(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void> {
    return this.#instrumentOperation('cancelWorkflow', async () => {
      this.ensureOpen()
      const resolvedHandle = resolveHandle(this.namespace, handle)

      const request = buildCancelRequest(resolvedHandle, this.defaultIdentity)
      await this.executeRpc(
        'cancelWorkflow',
        (rpcOptions) => this.workflowService.requestCancelWorkflowExecution(request, rpcOptions),
        callOptions,
      )
    })
  }

  async signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult> {
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

      const response = await this.executeRpc(
        'signalWithStartWorkflow',
        (rpcOptions) => this.workflowService.signalWithStartWorkflowExecution(request, rpcOptions),
        callOptions,
      )
      return this.toStartWorkflowResult(response, {
        workflowId: request.workflowId,
        namespace: request.namespace,
        firstExecutionRunId: response.started ? response.runId : undefined,
      })
    })
  }

  async describeNamespace(
    targetNamespace?: string,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<Uint8Array> {
    return this.#instrumentOperation('describeNamespace', async () => {
      this.ensureOpen()
      const request: DescribeNamespaceRequest = create(DescribeNamespaceRequestSchema, {
        namespace: targetNamespace ?? this.namespace,
      })

      const response = await this.executeRpc(
        'describeNamespace',
        (rpcOptions) => this.workflowService.describeNamespace(request, rpcOptions),
        callOptions,
      )
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

    if (this.transport) {
      const maybeClose = this.transport.close
      if (typeof maybeClose === 'function') {
        await maybeClose.call(this.transport)
      }
    }
    await this.#flushMetrics()
  }

  async #flushMetrics(): Promise<void> {
    try {
      await Effect.runPromise(this.#metricsExporter.flush())
    } catch (error) {
      this.#log('warn', 'failed to flush client metrics exporter', {
        error: describeError(error),
      })
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
      this.#log('debug', `temporal client ${operation} succeeded`, {
        operation,
        namespace: this.namespace,
      })
      this.#recordMetrics(Date.now() - start, false)
      return result
    } catch (error) {
      this.#log('error', `temporal client ${operation} failed`, {
        operation,
        error: describeError(error),
      })
      this.#recordMetrics(Date.now() - start, true)
      throw error
    }
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    void Effect.runPromise(
      this.#logger.log(level, message, fields).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn(`[temporal-bun-sdk] client logger failure: ${describeError(error)}`)
          }),
        ),
      ),
    )
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Temporal client has been shut down')
    }
  }

  #splitArgsAndOptions(args: unknown[]): { values: unknown[]; callOptions?: BrandedTemporalClientCallOptions } {
    if (!args.length) {
      return { values: [] }
    }
    const last = args[args.length - 1]
    if (isCallOptionsCandidate(last)) {
      return {
        values: args.slice(0, -1),
        callOptions: last,
      }
    }
    return { values: args }
  }

  #mergeRetryPolicy(overrides?: Partial<TemporalRpcRetryPolicy>): TemporalRpcRetryPolicy {
    const base = this.config.rpcRetryPolicy
    if (!overrides) {
      return {
        ...base,
        retryableStatusCodes: [...base.retryableStatusCodes],
      }
    }
    const maxAttempts = overrides.maxAttempts ?? base.maxAttempts
    const initialDelayMs = overrides.initialDelayMs ?? base.initialDelayMs
    const maxDelayMs = overrides.maxDelayMs ?? base.maxDelayMs
    const backoffCoefficient = overrides.backoffCoefficient ?? base.backoffCoefficient
    const jitterFactor = overrides.jitterFactor ?? base.jitterFactor
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error('retryPolicy.maxAttempts must be a positive integer')
    }
    if (!Number.isInteger(initialDelayMs) || initialDelayMs <= 0) {
      throw new Error('retryPolicy.initialDelayMs must be a positive integer')
    }
    if (!Number.isInteger(maxDelayMs) || maxDelayMs <= 0) {
      throw new Error('retryPolicy.maxDelayMs must be a positive integer')
    }
    if (maxDelayMs < initialDelayMs) {
      throw new Error('retryPolicy.maxDelayMs must be greater than or equal to retryPolicy.initialDelayMs')
    }
    if (typeof backoffCoefficient !== 'number' || !Number.isFinite(backoffCoefficient) || backoffCoefficient <= 0) {
      throw new Error('retryPolicy.backoffCoefficient must be a positive number')
    }
    if (typeof jitterFactor !== 'number' || jitterFactor < 0 || jitterFactor > 1) {
      throw new Error('retryPolicy.jitterFactor must be between 0 and 1')
    }
    const retryableStatusCodes = overrides.retryableStatusCodes
      ? [...overrides.retryableStatusCodes]
      : [...base.retryableStatusCodes]
    return {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      backoffCoefficient,
      jitterFactor,
      retryableStatusCodes,
    }
  }

  #buildCallContext(overrides?: TemporalClientCallOptions): {
    create: () => CallOptions
    retryPolicy: TemporalRpcRetryPolicy
  } {
    const userHeaders = overrides?.headers ? normalizeMetadataHeaders(overrides.headers) : undefined
    const mergedHeaders = userHeaders ? mergeHeaders(this.headers, userHeaders) : { ...this.headers }
    const timeout = overrides?.timeoutMs
    const signal = overrides?.signal
    return {
      create: () => ({
        headers: { ...mergedHeaders },
        timeoutMs: timeout,
        signal,
      }),
      retryPolicy: this.#mergeRetryPolicy(overrides?.retryPolicy),
    }
  }

  private async executeRpc<T>(
    operation: string,
    rpc: (options: CallOptions) => Promise<T>,
    overrides?: TemporalClientCallOptions,
  ): Promise<T> {
    const { create, retryPolicy } = this.#buildCallContext(overrides)
    let attempt = 0
    const effect = Effect.tryPromise({
      try: () => {
        attempt += 1
        return rpc(create())
      },
      catch: (error) => wrapRpcError(error),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          this.#log('warn', `temporal rpc ${operation} attempt failed`, {
            operation,
            attempt,
            error: describeError(error),
          })
        }),
      ),
    )
    const result = await Effect.runPromise(withTemporalRetry(effect, retryPolicy))
    if (attempt > 1) {
      this.#log('info', `temporal rpc ${operation} succeeded after ${attempt} attempts`, {
        operation,
        attempts: attempt,
      })
    }
    return result
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

export { buildTransportOptions, normalizeTemporalAddress } from './client/transport'

export type {
  SignalWithStartOptions,
  StartWorkflowOptions,
  StartWorkflowResult,
  TerminateWorkflowOptions,
  WorkflowHandle,
} from './client/types'
