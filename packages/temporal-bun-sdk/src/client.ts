import { create, toBinary } from '@bufbuild/protobuf'
import { type CallOptions, Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Context, Effect } from 'effect'
import * as Option from 'effect/Option'

import { createDefaultHeaders, mergeHeaders, normalizeMetadataHeaders } from './client/headers'
import { type InterceptorBuilder, makeDefaultInterceptorBuilder, type TemporalInterceptor } from './client/interceptors'
import type { TemporalRpcRetryPolicy } from './client/retries'
import {
  buildCancelRequest,
  buildPollWorkflowUpdateRequest,
  buildQueryRequest,
  buildSignalRequest,
  buildSignalWithStartRequest,
  buildStartWorkflowRequest,
  buildTerminateRequest,
  buildUpdateWorkflowRequest,
  computeSignalRequestId,
  createSignalRequestEntropy,
  createUpdateRequestId,
  decodeMemoAttributes,
  decodeSearchAttributes,
  decodeUpdateOutcome,
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
  type WorkflowUpdateAwaitOptions,
  type WorkflowUpdateHandle,
  type WorkflowUpdateOptions,
  type WorkflowUpdateResult,
  type WorkflowUpdateStage,
} from './client/types'
import {
  buildCodecsFromConfig,
  createDefaultDataConverter,
  type DataConverter,
  decodePayloadsToValues,
} from './common/payloads'
import { loadTemporalConfig, type TemporalConfig } from './config'
import {
  type ClientInterceptorBuilder,
  makeDefaultClientInterceptors,
  runClientInterceptors,
} from './interceptors/client'
import type { TemporalInterceptor as ClientMiddleware, InterceptorContext, InterceptorKind } from './interceptors/types'
import { createObservabilityServices } from './observability'
import type { LogFields, Logger, LogLevel } from './observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from './observability/metrics'
import {
  type Memo,
  type Payload,
  type SearchAttributes,
  type WorkflowExecution,
  WorkflowExecutionSchema,
} from './proto/temporal/api/common/v1/message_pb'
import type { QueryRejectCondition } from './proto/temporal/api/enums/v1/query_pb'
import { UpdateWorkflowExecutionLifecycleStage } from './proto/temporal/api/enums/v1/update_pb'
import { HistoryEventFilterType } from './proto/temporal/api/enums/v1/workflow_pb'
import type { HistoryEvent } from './proto/temporal/api/history/v1/message_pb'
import {
  type DescribeNamespaceRequest,
  DescribeNamespaceRequestSchema,
  DescribeNamespaceResponseSchema,
  GetWorkflowExecutionHistoryRequestSchema,
  type GetWorkflowExecutionHistoryResponse,
  type QueryWorkflowResponse,
  type SignalWithStartWorkflowExecutionResponse,
  type StartWorkflowExecutionResponse,
} from './proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from './proto/temporal/api/workflowservice/v1/service_pb'
import {
  DataConverterService,
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
  readonly queryRejectCondition?: QueryRejectCondition
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
  update(
    handle: WorkflowHandle,
    options: WorkflowUpdateOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  awaitUpdate(
    handle: WorkflowUpdateHandle,
    options?: WorkflowUpdateAwaitOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  cancelUpdate(handle: WorkflowUpdateHandle): Promise<void>
  getUpdateHandle(handle: WorkflowHandle, updateId: string, firstExecutionRunId?: string): WorkflowUpdateHandle
  result<T = unknown>(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<T>
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
  updateWorkflow(
    handle: WorkflowHandle,
    options: WorkflowUpdateOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  awaitWorkflowUpdate(
    handle: WorkflowUpdateHandle,
    options?: WorkflowUpdateAwaitOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  cancelWorkflowUpdate(handle: WorkflowUpdateHandle): Promise<void>
  getWorkflowUpdateHandle(handle: WorkflowHandle, updateId: string, firstExecutionRunId?: string): WorkflowUpdateHandle
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

const isAbortLikeError = (error: unknown): boolean =>
  (error instanceof Error && error.name === 'AbortError') ||
  (error instanceof ConnectError && error.code === Code.Canceled)

const normalizeUnknownError = (error: unknown): unknown => {
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') {
      return value
    }

    if (value instanceof TemporalTlsHandshakeError || value instanceof ConnectError) {
      return value
    }

    const candidate = value as { cause?: unknown; error?: unknown; _tag?: string }

    if (candidate.cause !== undefined) {
      return unwrap(candidate.cause)
    }
    if (candidate.error !== undefined) {
      return unwrap(candidate.error)
    }

    if (candidate._tag === 'UnknownException') {
      return unwrap(candidate.cause ?? candidate.error ?? value)
    }

    const symbols = Object.getOwnPropertySymbols(value)
    for (const symbol of symbols) {
      const inner = (value as Record<symbol, unknown>)[symbol]
      const unwrapped = unwrap(inner)
      if (unwrapped !== inner) {
        return unwrapped
      }
    }

    return value
  }

  return unwrap(error)
}

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
  clientInterceptors?: ClientMiddleware[]
  clientInterceptorBuilder?: ClientInterceptorBuilder
  tracingEnabled?: boolean
  workflowService?: WorkflowServiceClient
  transport?: ClosableTransport
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
  let transport = options.transport
  let workflowService = options.workflowService
  let createdTransport: ClosableTransport | undefined

  if (!workflowService) {
    if (!transport) {
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
      transport = createGrpcTransport(transportOptions) as ClosableTransport
      createdTransport = transport
    }

    if (!transport) {
      throw new Error('Temporal transport is not available')
    }

    workflowService = createClient(WorkflowService, transport)
  }

  if (!workflowService) {
    throw new Error('Temporal workflow service is not available')
  }

  const dataConverter =
    options.dataConverter ??
    createDefaultDataConverter({
      payloadCodecs: buildCodecsFromConfig(config.payloadCodecs),
      logger,
      metricsRegistry,
    })

  const effect = makeTemporalClientEffect({
    ...options,
    config,
    logger,
    metrics: metricsRegistry,
    metricsExporter,
    workflowService,
    transport,
    dataConverter,
  })

  try {
    return await Effect.runPromise(
      effect.pipe(
        Effect.provideService(TemporalConfigService, config),
        Effect.provideService(LoggerService, logger),
        Effect.provideService(MetricsService, metricsRegistry),
        Effect.provideService(MetricsExporterService, metricsExporter),
        Effect.provideService(WorkflowServiceClientService, workflowService),
        Effect.provideService(DataConverterService, dataConverter),
      ),
    )
  } catch (error) {
    await createdTransport?.close?.()
    throw error
  }
}

export const makeTemporalClientEffect = (
  options: CreateTemporalClientOptions = {},
): Effect.Effect<
  { client: TemporalClient; config: TemporalConfig },
  unknown,
  | TemporalConfigService
  | LoggerService
  | MetricsService
  | MetricsExporterService
  | WorkflowServiceClientService
  | DataConverterService
> =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* TemporalConfigService)
    const namespace = options.namespace ?? config.namespace
    const identity = options.identity ?? config.workerIdentity
    const taskQueue = options.taskQueue ?? config.taskQueue
    const logger = options.logger ?? (yield* LoggerService)
    const metricsRegistry = options.metrics ?? (yield* MetricsService)
    const metricsExporter = options.metricsExporter ?? (yield* MetricsExporterService)
    const contextualDataConverter = yield* Effect.contextWith((context) =>
      Context.getOption(context, DataConverterService),
    )
    const dataConverter =
      options.dataConverter ??
      Option.getOrUndefined(contextualDataConverter) ??
      createDefaultDataConverter({
        payloadCodecs: buildCodecsFromConfig(config.payloadCodecs),
        logger,
        metricsRegistry,
      })
    const initialHeaders = createDefaultHeaders(config.apiKey)
    const tracingEnabled = options.tracingEnabled ?? config.tracingInterceptorsEnabled ?? false
    const clientInterceptorBuilder: ClientInterceptorBuilder = options.clientInterceptorBuilder ?? {
      build: (input) => makeDefaultClientInterceptors(input),
    }
    const defaultClientInterceptors = yield* clientInterceptorBuilder.build({
      namespace,
      taskQueue,
      identity,
      logger,
      metricsRegistry,
      metricsExporter,
      retryPolicy: config.rpcRetryPolicy,
      tracingEnabled,
    })
    const clientInterceptors = [...defaultClientInterceptors, ...(options.clientInterceptors ?? [])]
    const workflowServiceFromContext = yield* Effect.contextWith((context) =>
      Context.getOption(context, WorkflowServiceClientService),
    )
    let workflowService = options.workflowService ?? Option.getOrUndefined(workflowServiceFromContext)
    let transport: ClosableTransport | undefined = options.transport

    if (!workflowService) {
      if (!transport) {
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
      }
      if (!transport) {
        throw new Error('Temporal transport is not available')
      }
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
      clientInterceptors,
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
  #clientInterceptors: ClientMiddleware[]
  #pendingUpdateControllers = new Map<string, Set<AbortController>>()
  #abortedUpdates = new Set<string>()
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
    clientInterceptors: ClientMiddleware[]
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
    this.#clientInterceptors = handles.clientInterceptors
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
      update: (workflowHandle, updateOptions, callOptions) =>
        this.updateWorkflow(workflowHandle, updateOptions, callOptions),
      awaitUpdate: (updateHandle, options, callOptions) => this.awaitWorkflowUpdate(updateHandle, options, callOptions),
      cancelUpdate: (updateHandle) => this.cancelWorkflowUpdate(updateHandle),
      getUpdateHandle: (workflowHandle, updateId, firstExecutionRunId) =>
        this.getWorkflowUpdateHandle(workflowHandle, updateId, firstExecutionRunId),
      result: (handle, callOptions) => this.getWorkflowResult(handle, callOptions),
    }
  }

  async startWorkflow(
    options: StartWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult> {
    const parsedOptions = sanitizeStartWorkflowOptions(options)
    return this.#instrumentOperation(
      'workflow.start',
      async () => {
        this.ensureOpen()
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
      },
      {
        workflowId: parsedOptions.workflowId,
        taskQueue: options.taskQueue ?? this.defaultTaskQueue,
      },
    )
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...rawArgs: unknown[]): Promise<void> {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.signal',
      async () => {
        this.ensureOpen()
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
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId, taskQueue: this.defaultTaskQueue },
    )
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...rawArgs: unknown[]): Promise<unknown> {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.query',
      async () => {
        this.ensureOpen()
        const { values, callOptions } = this.#splitArgsAndOptions(rawArgs)

        const request = await buildQueryRequest(resolvedHandle, queryName, values, this.dataConverter, {
          rejectCondition: callOptions?.queryRejectCondition,
        })
        const response = await this.executeRpc(
          'queryWorkflow',
          (rpcOptions) => this.workflowService.queryWorkflow(request, rpcOptions),
          callOptions,
        )

        return this.parseQueryResult(response)
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId },
    )
  }

  async terminateWorkflow(
    handle: WorkflowHandle,
    options: TerminateWorkflowOptions = {},
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void> {
    return this.#instrumentOperation(
      'workflow.terminate',
      async () => {
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
      },
      { workflowId: handle.workflowId, runId: handle.runId },
    )
  }

  async cancelWorkflow(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void> {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.cancel',
      async () => {
        this.ensureOpen()

        const request = buildCancelRequest(resolvedHandle, this.defaultIdentity)
        await this.executeRpc(
          'cancelWorkflow',
          (rpcOptions) => this.workflowService.requestCancelWorkflowExecution(request, rpcOptions),
          callOptions,
        )
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId },
    )
  }

  async getWorkflowResult<T = unknown>(
    handle: WorkflowHandle,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<T> {
    let resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.result',
      async () => {
        this.ensureOpen()
        while (true) {
          const execution: WorkflowExecution = create(WorkflowExecutionSchema, {
            workflowId: resolvedHandle.workflowId,
            ...(resolvedHandle.runId ? { runId: resolvedHandle.runId } : {}),
          })

          const request = create(GetWorkflowExecutionHistoryRequestSchema, {
            namespace: resolvedHandle.namespace ?? this.namespace,
            execution,
            maximumPageSize: 1,
            historyEventFilterType: HistoryEventFilterType.CLOSE_EVENT,
            waitNewEvent: true,
            skipArchival: true,
          })

          const response = await this.executeRpc(
            'getWorkflowExecutionHistory',
            (rpcOptions) => this.workflowService.getWorkflowExecutionHistory(request, rpcOptions),
            callOptions,
          )

          const closeEvent = this.#extractCloseEvent(response)
          if (!closeEvent || !closeEvent.attributes) {
            continue
          }

          const attributes = closeEvent.attributes
          switch (attributes.case) {
            case 'workflowExecutionContinuedAsNewEventAttributes': {
              const nextRunId = attributes.value.newExecutionRunId
              if (!nextRunId) {
                throw new Error('Continue-as-new event missing newExecutionRunId')
              }
              resolvedHandle = { ...resolvedHandle, runId: nextRunId }
              continue
            }
            case 'workflowExecutionCompletedEventAttributes': {
              const payloads = attributes.value.result?.payloads ?? []
              const decoded = await this.dataConverter.fromPayloads(payloads)
              return (decoded.length <= 1 ? (decoded[0] as T) : (decoded as unknown as T)) ?? (undefined as T)
            }
            case 'workflowExecutionFailedEventAttributes': {
              const failure = await this.dataConverter.decodeFailurePayloads(attributes.value.failure)
              const error = await this.dataConverter.failureToError(failure)
              throw error ?? new Error('Workflow failed')
            }
            case 'workflowExecutionTimedOutEventAttributes':
              throw new Error('Workflow timed out')
            case 'workflowExecutionCanceledEventAttributes': {
              const details = attributes.value.details?.payloads ?? []
              const decoded = await this.dataConverter.fromPayloads(details)
              const detail = decoded.length <= 1 ? decoded[0] : decoded
              throw new Error(
                detail ? `Workflow canceled: ${JSON.stringify(detail)}` : 'Workflow canceled without details',
              )
            }
            case 'workflowExecutionTerminatedEventAttributes': {
              const reason = attributes.value.reason
              throw new Error(reason ? `Workflow terminated: ${reason}` : 'Workflow terminated')
            }
            default:
              throw new Error(`Unsupported workflow close event type: ${attributes.case}`)
          }
        }
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId },
    )
  }

  async signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult> {
    const startOptions = sanitizeStartWorkflowOptions(options)
    return this.#instrumentOperation(
      'workflow.signalWithStart',
      async () => {
        this.ensureOpen()
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
      },
      { workflowId: startOptions.workflowId },
    )
  }

  async updateWorkflow(
    handle: WorkflowHandle,
    options: WorkflowUpdateOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const parsedOptions = sanitizeWorkflowUpdateOptions(options)
    const updateId = parsedOptions.updateId ?? createUpdateRequestId()
    const waitStage = this.#stageToProto(parsedOptions.waitForStage)
    return this.#instrumentOperation(
      'workflow.update',
      async () => {
        const updateKey = this.#makeUpdateKey(resolvedHandle, updateId)
        const {
          options: mergedCallOptions,
          controller,
          cleanup,
        } = this.#prepareUpdateCallOptions(updateKey, callOptions)

        try {
          const request = await buildUpdateWorkflowRequest(
            {
              handle: resolvedHandle,
              namespace: this.namespace,
              identity: this.defaultIdentity,
              updateId,
              updateName: parsedOptions.updateName,
              args: parsedOptions.args,
              headers: parsedOptions.headers,
              waitStage,
              firstExecutionRunId: parsedOptions.firstExecutionRunId,
            },
            this.dataConverter,
          )

          let response = await this.executeRpc(
            'updateWorkflowExecution',
            (rpcOptions) => this.workflowService.updateWorkflowExecution(request, rpcOptions),
            mergedCallOptions,
          )

          while ((response.stage ?? UpdateWorkflowExecutionLifecycleStage.UNSPECIFIED) < waitStage) {
            response = await this.executeRpc(
              'updateWorkflowExecution',
              (rpcOptions) => this.workflowService.updateWorkflowExecution(request, rpcOptions),
              mergedCallOptions,
            )
          }

          const runId = response.updateRef?.workflowExecution?.runId || resolvedHandle.runId
          const updateHandle = this.#createWorkflowUpdateHandle(resolvedHandle, {
            updateId,
            runId,
            firstExecutionRunId: parsedOptions.firstExecutionRunId,
          })
          const stage = this.#stageFromProto(response.stage)
          const outcome = await decodeUpdateOutcome(this.dataConverter, response.outcome)
          return {
            handle: updateHandle,
            stage,
            outcome,
          }
        } finally {
          this.#releaseUpdateController(updateKey, controller)
          cleanup?.()
        }
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId, updateId },
    )
  }

  async awaitWorkflowUpdate(
    handle: WorkflowUpdateHandle,
    options: WorkflowUpdateAwaitOptions = {},
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const updateId = ensureNonEmptyString(handle.updateId, 'updateId')
    const waitStage = this.#stageToProto(options.waitForStage ?? 'completed')
    const firstExecutionRunIdOverride = ensureOptionalTrimmedString(
      options.firstExecutionRunId,
      'firstExecutionRunId',
      1,
    )
    const pollHandle: WorkflowHandle = {
      workflowId: resolvedHandle.workflowId,
      namespace: resolvedHandle.namespace,
      runId: resolvedHandle.runId,
      firstExecutionRunId: firstExecutionRunIdOverride ?? resolvedHandle.firstExecutionRunId,
    }
    return this.#instrumentOperation(
      'workflow.awaitUpdate',
      async () => {
        const request = buildPollWorkflowUpdateRequest({
          handle: pollHandle,
          namespace: this.namespace,
          identity: this.defaultIdentity,
          updateId,
          waitStage,
        })
        const updateKey = this.#makeUpdateKey(resolvedHandle, updateId)
        const {
          options: mergedCallOptions,
          controller,
          cleanup,
        } = this.#prepareUpdateCallOptions(updateKey, callOptions)

        const throwIfAborted = () => {
          if (controller.signal.aborted || this.#abortedUpdates.has(updateKey)) {
            this.#abortedUpdates.delete(updateKey)
            const abortError = new Error('Workflow update polling aborted')
            abortError.name = 'AbortError'
            throw abortError
          }
        }

        throwIfAborted()

        try {
          const response = await this.executeRpc(
            'pollWorkflowExecutionUpdate',
            (rpcOptions) => this.workflowService.pollWorkflowExecutionUpdate(request, rpcOptions),
            mergedCallOptions,
          )
          const stage = this.#stageFromProto(response.stage)
          const runId = response.updateRef?.workflowExecution?.runId || resolvedHandle.runId
          const updateHandle = this.#createWorkflowUpdateHandle(resolvedHandle, {
            updateId,
            runId,
            firstExecutionRunId: pollHandle.firstExecutionRunId,
          })
          const outcome = await decodeUpdateOutcome(this.dataConverter, response.outcome)
          return {
            handle: updateHandle,
            stage,
            outcome,
          }
        } catch (error) {
          throwIfAborted()
          throw error
        } finally {
          this.#abortedUpdates.delete(updateKey)
          this.#releaseUpdateController(updateKey, controller)
          cleanup?.()
        }
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId, updateId },
    )
  }

  getWorkflowUpdateHandle(
    handle: WorkflowHandle,
    updateId: string,
    firstExecutionRunId?: string,
  ): WorkflowUpdateHandle {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const normalizedUpdateId = ensureNonEmptyString(updateId, 'updateId')
    const normalizedFirstExecution = ensureOptionalTrimmedString(firstExecutionRunId, 'firstExecutionRunId', 1)
    return this.#createWorkflowUpdateHandle(resolvedHandle, {
      updateId: normalizedUpdateId,
      firstExecutionRunId: normalizedFirstExecution,
    })
  }

  async cancelWorkflowUpdate(handle: WorkflowUpdateHandle): Promise<void> {
    return this.#instrumentOperation(
      'workflow.update',
      async () => {
        this.ensureOpen()
        const resolvedHandle = resolveHandle(this.namespace, handle)
        const updateId = ensureNonEmptyString(handle.updateId, 'updateId')
        const updateKey = this.#makeUpdateKey(resolvedHandle, updateId)
        const aborted = this.#abortUpdateControllers(updateKey)
        if (!aborted) {
          this.#log('debug', 'no pending workflow update operation to cancel', {
            workflowId: resolvedHandle.workflowId,
            updateId,
          })
        }
      },
      { workflowId: handle.workflowId, runId: handle.runId, updateId: handle.updateId },
    )
  }

  async describeNamespace(
    targetNamespace?: string,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<Uint8Array> {
    return this.#instrumentOperation(
      'workflow.describe',
      async () => {
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
      },
      { namespace: targetNamespace ?? this.namespace },
    )
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

  async #instrumentOperation<T>(
    operation: InterceptorKind,
    action: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const context = {
      kind: operation,
      namespace: this.namespace,
      taskQueue: (metadata.taskQueue as string | undefined) ?? this.defaultTaskQueue,
      identity: this.defaultIdentity,
      workflowId: metadata.workflowId as string | undefined,
      runId: metadata.runId as string | undefined,
      updateId: metadata.updateId as string | undefined,
      metadata,
    }
    const start = Date.now()
    const effect = runClientInterceptors<T>(this.#clientInterceptors, context, () => Effect.tryPromise(action))
    try {
      const result = await Effect.runPromise(effect)
      this.#log('debug', `temporal client ${operation} succeeded`, {
        operation,
        namespace: this.namespace,
        ...metadata,
      })
      this.#recordMetrics(Date.now() - start, false)
      return result
    } catch (error) {
      const normalized = normalizeUnknownError(error)
      const finalError =
        normalized instanceof Error &&
        normalized.message.toLowerCase().includes('unknown error occurred in effect.trypromise')
          ? ((normalized as { cause?: unknown; error?: unknown }).cause ??
            (normalized as { cause?: unknown; error?: unknown }).error ??
            normalized)
          : normalized
      const message = finalError instanceof Error ? finalError.message.toLowerCase() : ''
      const isUnknownPollAbort =
        operation === 'workflow.awaitUpdate' && message.includes('unknown error occurred in effect.trypromise')
      if (isAbortLikeError(normalized)) {
        this.#log('warn', `temporal client ${operation} aborted`, {
          operation,
          error: describeError(normalized),
          ...metadata,
        })
        this.#recordMetrics(Date.now() - start, true)
        throw finalError
      }
      if (isUnknownPollAbort) {
        const abortError = new Error('Workflow update polling aborted')
        abortError.name = 'AbortError'
        this.#log('warn', `temporal client ${operation} aborted`, {
          operation,
          error: describeError(abortError),
          ...metadata,
        })
        this.#recordMetrics(Date.now() - start, true)
        throw abortError
      }
      this.#log('error', `temporal client ${operation} failed`, {
        operation,
        error: describeError(finalError),
        ...metadata,
      })
      this.#recordMetrics(Date.now() - start, true)
      throw finalError
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

  #prepareUpdateCallOptions(
    key: string,
    callOptions?: BrandedTemporalClientCallOptions,
  ): { options: TemporalClientCallOptions; controller: AbortController; cleanup?: () => void } {
    const controller = new AbortController()
    let cleanup: (() => void) | undefined
    if (callOptions?.signal) {
      if (callOptions.signal.aborted) {
        controller.abort()
      } else {
        const onAbort = () => controller.abort()
        callOptions.signal.addEventListener('abort', onAbort, { once: true })
        cleanup = () => callOptions.signal?.removeEventListener('abort', onAbort)
      }
    }
    this.#registerUpdateController(key, controller)
    const overrides: TemporalClientCallOptions = {
      ...(callOptions ? { ...callOptions } : {}),
      signal: controller.signal,
    }
    return { options: overrides, controller, cleanup }
  }

  #registerUpdateController(key: string, controller: AbortController): void {
    this.#abortedUpdates.delete(key)
    const current = this.#pendingUpdateControllers.get(key)
    if (current) {
      current.add(controller)
      return
    }
    this.#pendingUpdateControllers.set(key, new Set([controller]))
  }

  #releaseUpdateController(key: string, controller: AbortController): void {
    const current = this.#pendingUpdateControllers.get(key)
    if (!current) {
      return
    }
    current.delete(controller)
    if (current.size === 0) {
      this.#pendingUpdateControllers.delete(key)
    }
  }

  #abortUpdateControllers(key: string): boolean {
    const current = this.#pendingUpdateControllers.get(key)
    if (!current || current.size === 0) {
      this.#abortedUpdates.add(key)
      return false
    }
    for (const controller of current) {
      controller.abort()
    }
    this.#pendingUpdateControllers.delete(key)
    this.#abortedUpdates.add(key)
    return true
  }

  #makeUpdateKey(handle: WorkflowHandle, updateId: string): string {
    const namespace = handle.namespace ?? this.namespace
    const runId = handle.runId ?? ''
    return `${namespace}::${handle.workflowId}::${runId}::${updateId}`
  }

  #createWorkflowUpdateHandle(
    handle: WorkflowHandle,
    overrides: { updateId: string; runId?: string | null; firstExecutionRunId?: string | null },
  ): WorkflowUpdateHandle {
    return {
      workflowId: handle.workflowId,
      namespace: handle.namespace,
      runId: overrides.runId ?? handle.runId,
      firstExecutionRunId: overrides.firstExecutionRunId ?? handle.firstExecutionRunId,
      updateId: overrides.updateId,
    }
  }

  #stageToProto(
    stage: WorkflowUpdateStage | undefined,
    minimum: UpdateWorkflowExecutionLifecycleStage = UpdateWorkflowExecutionLifecycleStage.ADMITTED,
  ): UpdateWorkflowExecutionLifecycleStage {
    const normalized = ensureWorkflowUpdateStage(stage)
    const protoStage = WORKFLOW_UPDATE_STAGE_TO_PROTO[normalized]
    return protoStage >= minimum ? protoStage : minimum
  }

  #stageFromProto(stage?: UpdateWorkflowExecutionLifecycleStage): WorkflowUpdateStage {
    if (stage === UpdateWorkflowExecutionLifecycleStage.ADMITTED) {
      return 'admitted'
    }
    if (stage === UpdateWorkflowExecutionLifecycleStage.ACCEPTED) {
      return 'accepted'
    }
    if (stage === UpdateWorkflowExecutionLifecycleStage.COMPLETED) {
      return 'completed'
    }
    return 'unspecified'
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

  #extractCloseEvent(response: GetWorkflowExecutionHistoryResponse | null | undefined): HistoryEvent | undefined {
    const events = response?.history?.events ?? []
    if (events.length === 0) {
      return undefined
    }
    return events[events.length - 1]
  }

  #buildCallContext(overrides?: TemporalClientCallOptions): {
    create: () => CallOptions
    retryPolicy: TemporalRpcRetryPolicy
    headers: Record<string, string>
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
      headers: mergedHeaders,
    }
  }

  private async executeRpc<T>(
    operation: string,
    rpc: (options: CallOptions) => Promise<T>,
    overrides?: TemporalClientCallOptions,
  ): Promise<T> {
    const { create, retryPolicy, headers } = this.#buildCallContext(overrides)
    const interceptorContext: Omit<InterceptorContext, 'direction'> = {
      kind: 'rpc' as InterceptorKind,
      namespace: this.namespace,
      taskQueue: this.defaultTaskQueue,
      identity: this.defaultIdentity,
      headers,
      metadata: { retryPolicy },
    }

    const baseEffect = () =>
      Effect.tryPromise({
        try: () => {
          interceptorContext.attempt = (interceptorContext.attempt ?? 0) + 1
          return rpc(create())
        },
        catch: (error) => wrapRpcError(error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            this.#log('warn', `temporal rpc ${operation} attempt failed`, {
              operation,
              attempt: interceptorContext.attempt,
              error: describeError(error),
            })
          }),
        ),
      )

    const result = await Effect.runPromise(
      runClientInterceptors<T>(this.#clientInterceptors, interceptorContext, baseEffect),
    )
    if ((interceptorContext.attempt ?? 1) > 1) {
      this.#log('info', `temporal rpc ${operation} succeeded after ${interceptorContext.attempt} attempts`, {
        operation,
        attempts: interceptorContext.attempt,
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

type NormalizedWorkflowUpdateOptions = {
  updateName: string
  args: unknown[]
  headers?: Record<string, unknown>
  updateId?: string
  waitForStage: WorkflowUpdateStage
  firstExecutionRunId?: string
}

const sanitizeWorkflowUpdateOptions = (options: WorkflowUpdateOptions): NormalizedWorkflowUpdateOptions => {
  if (!options || typeof options !== 'object') {
    throw new Error('Workflow update options must be provided')
  }
  const updateName = ensureNonEmptyString(options.updateName, 'updateName')
  const args = options.args ?? []
  if (!Array.isArray(args)) {
    throw new Error('update args must be an array when provided')
  }
  const waitForStage = ensureWorkflowUpdateStage(options.waitForStage)
  const updateId = ensureOptionalTrimmedString(options.updateId, 'updateId', 1)
  const firstExecutionRunId = ensureOptionalTrimmedString(options.firstExecutionRunId, 'firstExecutionRunId', 1)
  return {
    updateName,
    args,
    headers: options.headers,
    updateId,
    waitForStage,
    firstExecutionRunId,
  }
}

const WORKFLOW_UPDATE_STAGE_VALUES: ReadonlySet<WorkflowUpdateStage> = new Set([
  'unspecified',
  'admitted',
  'accepted',
  'completed',
])

const DEFAULT_WORKFLOW_UPDATE_STAGE: WorkflowUpdateStage = 'accepted'

const WORKFLOW_UPDATE_STAGE_TO_PROTO: Record<WorkflowUpdateStage, UpdateWorkflowExecutionLifecycleStage> = {
  unspecified: UpdateWorkflowExecutionLifecycleStage.UNSPECIFIED,
  admitted: UpdateWorkflowExecutionLifecycleStage.ADMITTED,
  accepted: UpdateWorkflowExecutionLifecycleStage.ACCEPTED,
  completed: UpdateWorkflowExecutionLifecycleStage.COMPLETED,
}

const ensureWorkflowUpdateStage = (stage?: WorkflowUpdateStage): WorkflowUpdateStage => {
  if (!stage) {
    return DEFAULT_WORKFLOW_UPDATE_STAGE
  }
  if (!WORKFLOW_UPDATE_STAGE_VALUES.has(stage)) {
    throw new Error('waitForStage must be one of unspecified, admitted, accepted, or completed')
  }
  return stage
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
  WorkflowUpdateAwaitOptions,
  WorkflowUpdateHandle,
  WorkflowUpdateOptions,
  WorkflowUpdateOutcome,
  WorkflowUpdateResult,
  WorkflowUpdateStage,
} from './client/types'
