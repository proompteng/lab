import { ConnectError } from '@connectrpc/connect'
import { z } from 'zod'

import {
  buildCancelWorkflowExecutionRequest,
  buildGetWorkflowExecutionHistoryRequest,
  buildQueryWorkflowRequest,
  buildSignalWithStartWorkflowExecutionRequest,
  buildSignalWorkflowExecutionRequest,
  buildStartWorkflowExecutionRequest,
  buildTerminateWorkflowExecutionRequest,
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
import { createDefaultDataConverter, type DataConverter, decodePayloadsToValues } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig, type TLSConfig } from './config'
import {
  createWorkflowServiceClient,
  type WorkflowServiceClientOptions,
  type WorkflowServiceHandle,
} from './grpc/workflow-service-client'
import {
  DescribeNamespaceRequest,
  type DescribeNamespaceResponse,
  type GetWorkflowExecutionHistoryResponse,
  type QueryWorkflowResponse,
  type SignalWithStartWorkflowExecutionResponse,
} from './proto/temporal/api/workflowservice/v1/request_response_pb'

const metadataHeadersSchema = z
  .record(
    z.union([
      z.string(),
      z.instanceof(ArrayBuffer),
      z.custom<ArrayBufferView>(
        (value) => typeof value === 'object' && value !== null && ArrayBuffer.isView(value),
        'Header values must be strings or byte arrays',
      ),
    ]),
  )
  .transform((headers, ctx) => {
    const normalized: Record<string, string> = {}
    const seen = new Set<string>()

    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const trimmedKey = rawKey.trim()
      if (trimmedKey.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header keys must be non-empty strings',
          path: [rawKey],
        })
        continue
      }

      if (trimmedKey !== rawKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header keys must not include leading or trailing whitespace',
          path: [rawKey],
        })
      }

      const normalizedKey = trimmedKey.toLowerCase()
      if (seen.has(normalizedKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Header key '${normalizedKey}' is duplicated (case-insensitive match)`,
          path: [rawKey],
        })
        continue
      }
      seen.add(normalizedKey)

      const isBinaryKey = normalizedKey.endsWith('-bin')

      if (typeof rawValue === 'string') {
        const trimmedValue = rawValue.trim()
        if (trimmedValue.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Header values must be non-empty strings',
            path: [rawKey],
          })
          continue
        }

        if (isBinaryKey) {
          normalized[normalizedKey] = Buffer.from(trimmedValue, 'utf8').toString('base64')
          continue
        }

        if (!isPrintableAscii(trimmedValue)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Header '${normalizedKey}' values must contain printable ASCII characters; use '-bin' for binary metadata`,
            path: [rawKey],
          })
          continue
        }

        normalized[normalizedKey] = trimmedValue
        continue
      }

      const isArrayBuffer = rawValue instanceof ArrayBuffer
      const isArrayBufferView = !isArrayBuffer && ArrayBuffer.isView(rawValue)

      if (!isArrayBuffer && !isArrayBufferView) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header values must be strings or byte arrays',
          path: [rawKey],
        })
        continue
      }

      if (!isBinaryKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Header '${normalizedKey}' accepts string values only; append '-bin' to use binary metadata`,
          path: [rawKey],
        })
        continue
      }

      const bytes = toUint8Array(rawValue as ArrayBuffer | ArrayBufferView)
      if (bytes.byteLength === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header values must be non-empty byte arrays',
          path: [rawKey],
        })
        continue
      }

      normalized[normalizedKey] = Buffer.from(bytes).toString('base64')
    }

    return normalized
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

type ClientHeaderValue = string | ArrayBuffer | ArrayBufferView
type ClientHeaderInput = Record<string, ClientHeaderValue>
export type ClientMetadataHeaders = ClientHeaderInput

const startWorkflowMetadataSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  namespace: z.string().min(1),
  firstExecutionRunId: z.string().min(1).optional(),
})

const toUint8Array = (value: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

const isPrintableAscii = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) {
      return false
    }
  }
  return true
}

const toStartWorkflowResult = (metadata: WorkflowHandleMetadata): StartWorkflowResult => ({
  ...metadata,
  handle: createWorkflowHandle(metadata),
})

const toNamespaceRequest = (namespace: string): DescribeNamespaceRequest => new DescribeNamespaceRequest({ namespace })

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
  describeNamespace(namespace?: string): Promise<DescribeNamespaceResponse>
  updateHeaders(headers: ClientHeaderInput): Promise<void>
  getWorkflowExecutionHistory(handle: WorkflowHandle): Promise<GetWorkflowExecutionHistoryResponse>
  shutdown(): Promise<void>
}

export interface CreateTemporalClientOptions {
  config?: TemporalConfig
  namespace?: string
  identity?: string
  taskQueue?: string
  dataConverter?: DataConverter
  workflowServiceFactory?: (options: WorkflowServiceClientOptions) => WorkflowServiceHandle
}

export const createTemporalClient = async (
  options: CreateTemporalClientOptions = {},
): Promise<{ client: TemporalClient; config: TemporalConfig }> => {
  const config = options.config ?? (await loadTemporalConfig())

  const namespace = options.namespace ?? config.namespace
  const identity = options.identity ?? config.workerIdentity
  const taskQueue = options.taskQueue ?? config.taskQueue
  const dataConverter = options.dataConverter ?? createDefaultDataConverter()

  const handleFactory =
    options.workflowServiceFactory ??
    ((serviceOptions: WorkflowServiceClientOptions) => createWorkflowServiceClient(serviceOptions))

  const workflowServiceHandle = handleFactory({
    address: config.address,
    tls: config.tls as TLSConfig | undefined,
    apiKey: config.apiKey,
    metadata: {},
    allowInsecureTls: config.allowInsecureTls,
  })

  const client = new TemporalClientImpl({
    config,
    namespace,
    identity,
    taskQueue,
    dataConverter,
    workflowService: workflowServiceHandle,
  })

  return { client, config }
}

class TemporalClientImpl implements TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient

  private closed = false
  private readonly identity: string
  private readonly taskQueue: string
  private readonly serviceHandle: WorkflowServiceHandle

  constructor(params: {
    config: TemporalConfig
    namespace: string
    identity: string
    taskQueue: string
    dataConverter: DataConverter
    workflowService: WorkflowServiceHandle
  }) {
    this.config = params.config
    this.namespace = params.namespace
    this.identity = params.identity
    this.taskQueue = params.taskQueue
    this.dataConverter = params.dataConverter
    this.serviceHandle = params.workflowService

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
    const parsed = startWorkflowOptionsSchema.parse(options)
    const request = await buildStartWorkflowExecutionRequest(
      {
        options: parsed,
        defaults: {
          namespace: this.namespace,
          identity: this.identity,
          taskQueue: this.taskQueue,
        },
      },
      this.dataConverter,
    )

    const response = await this.serviceHandle.client.startWorkflowExecution(request)
    return toStartWorkflowResult(this.extractStartMetadata(parsed.workflowId, request.namespace, response.runId ?? ''))
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void> {
    this.ensureOpen()
    const entropy = createSignalRequestEntropy()
    const requestId = await computeSignalRequestId(
      {
        namespace: handle.namespace ?? this.namespace,
        workflowId: handle.workflowId,
        runId: handle.runId,
        firstExecutionRunId: handle.firstExecutionRunId,
        signalName,
        identity: this.identity,
        args,
      },
      this.dataConverter,
      { entropy },
    )

    const request = await buildSignalWorkflowExecutionRequest(
      {
        handle,
        signalName,
        args,
        identity: this.identity,
        requestId,
        namespaceFallback: this.namespace,
      },
      this.dataConverter,
    )
    await this.serviceHandle.client.signalWorkflowExecution(request)
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown> {
    this.ensureOpen()
    const request = await buildQueryWorkflowRequest(handle, queryName, args, this.namespace, this.dataConverter)
    const response = await this.serviceHandle.client.queryWorkflow(request)
    return this.decodeQueryResponse(response)
  }

  async terminateWorkflow(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void> {
    this.ensureOpen()
    const parsedOptions = options ? terminateWorkflowOptionsSchema.parse(options) : undefined
    const request = await buildTerminateWorkflowExecutionRequest(
      handle,
      parsedOptions,
      this.namespace,
      this.identity,
      this.dataConverter,
    )
    await this.serviceHandle.client.terminateWorkflowExecution(request)
  }

  async cancelWorkflow(handle: WorkflowHandle): Promise<void> {
    this.ensureOpen()
    const request = buildCancelWorkflowExecutionRequest(handle, this.namespace, this.identity)
    await this.serviceHandle.client.requestCancelWorkflowExecution(request)
  }

  async signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult> {
    this.ensureOpen()
    const entropy = createSignalRequestEntropy()
    const requestId = await computeSignalRequestId(
      {
        namespace: options.namespace ?? this.namespace,
        workflowId: options.workflowId,
        runId: undefined,
        firstExecutionRunId: undefined,
        signalName: options.signalName,
        identity: options.identity ?? this.identity,
        args: options.signalArgs ?? [],
      },
      this.dataConverter,
      { entropy },
    )

    const request = await buildSignalWithStartWorkflowExecutionRequest(
      {
        options: {
          ...options,
          requestId,
        },
        defaults: {
          namespace: this.namespace,
          identity: this.identity,
          taskQueue: this.taskQueue,
        },
      },
      this.dataConverter,
    )

    const response: SignalWithStartWorkflowExecutionResponse =
      await this.serviceHandle.client.signalWithStartWorkflowExecution(request)
    return toStartWorkflowResult(this.extractStartMetadata(options.workflowId, request.namespace, response.runId ?? ''))
  }

  async describeNamespace(namespace?: string): Promise<DescribeNamespaceResponse> {
    this.ensureOpen()
    const request = toNamespaceRequest(namespace ?? this.namespace)
    return await this.serviceHandle.client.describeNamespace(request)
  }

  async getWorkflowExecutionHistory(handle: WorkflowHandle): Promise<GetWorkflowExecutionHistoryResponse> {
    this.ensureOpen()
    const request = buildGetWorkflowExecutionHistoryRequest(handle, this.namespace)
    return await this.serviceHandle.client.getWorkflowExecutionHistory(request)
  }

  async updateHeaders(headers: ClientHeaderInput): Promise<void> {
    this.ensureOpen()
    const normalized = metadataHeadersSchema.parse(headers)
    this.serviceHandle.setMetadata(normalized)
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.serviceHandle.setMetadata({})
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Temporal client has already been shut down')
    }
  }

  private extractStartMetadata(workflowId: string, namespace: string, runId: string): WorkflowHandleMetadata {
    const metadata = startWorkflowMetadataSchema.parse({
      workflowId,
      namespace,
      runId,
      firstExecutionRunId: runId,
    })
    return metadata
  }

  private async decodeQueryResponse(response: QueryWorkflowResponse): Promise<unknown> {
    if (response.queryRejected) {
      throw new ConnectError('Workflow query rejected', undefined, response.queryRejected)
    }
    const payloads = response.queryResult?.payloads ?? []
    const [value] = await decodePayloadsToValues(this.dataConverter, payloads)
    return value ?? null
  }
}
