import { z } from 'zod'
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
import { loadTemporalConfig, type TemporalConfig, type TLSConfig } from './config'
import { type NativeClient, native, type Runtime } from './internal/core-bridge/native'

const startWorkflowMetadataSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  namespace: z.string().min(1),
  firstExecutionRunId: z.string().min(1).optional(),
})

const toStartWorkflowResult = (metadata: WorkflowHandleMetadata): StartWorkflowResult => ({
  ...metadata,
  handle: createWorkflowHandle(metadata),
})

const isPrintableAscii = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) {
      return false
    }
  }
  return true
}

const toUint8Array = (value: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

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

type ClientHeaderValue = string | ArrayBuffer | ArrayBufferView
type ClientHeaderInput = Record<string, ClientHeaderValue>
export type ClientMetadataHeaders = ClientHeaderInput

const retryPolicySchema = z
  .object({
    initialIntervalMs: z.number().int().positive().optional(),
    maximumIntervalMs: z.number().int().positive().optional(),
    maximumAttempts: z.number().int().optional(),
    backoffCoefficient: z.number().positive().optional(),
    nonRetryableErrorTypes: z.array(z.string().min(1)).optional(),
  })
  .optional()

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
  retryPolicy: retryPolicySchema,
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

const workflowQueryNameSchema = z.string().min(1)
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
  readonly workflow: TemporalWorkflowClient
  startWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminateWorkflow(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancelWorkflow(handle: WorkflowHandle): Promise<void>
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
  describeNamespace(namespace?: string): Promise<Uint8Array>
  updateHeaders(headers: ClientHeaderInput): Promise<void>
  shutdown(): Promise<void>
}

export interface CreateTemporalClientOptions {
  config?: TemporalConfig
  runtimeOptions?: Record<string, unknown>
  namespace?: string
  identity?: string
  taskQueue?: string
}

const textDecoder = new TextDecoder()

export const createTemporalClient = async (
  options: CreateTemporalClientOptions = {},
): Promise<{ client: TemporalClient; config: TemporalConfig }> => {
  const config = options.config ?? (await loadTemporalConfig())

  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const namespace = options.namespace ?? config.namespace
  const identity = options.identity ?? config.workerIdentity
  const taskQueue = options.taskQueue ?? config.taskQueue

  const runtime = native.createRuntime(options.runtimeOptions ?? {})
  const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)

  const nativeConfig: Record<string, unknown> = {
    address: formatTemporalAddress(config.address, shouldUseTls),
    namespace,
    identity,
  }

  if (config.apiKey) {
    nativeConfig.apiKey = config.apiKey
  }

  const tlsPayload = serializeTlsConfig(config.tls)
  if (tlsPayload) {
    nativeConfig.tls = tlsPayload
  }

  if (config.allowInsecureTls) {
    nativeConfig.allowInsecure = true
  }

  const clientHandle = await native.createClient(runtime, nativeConfig)

  const client = new TemporalClientImpl({
    runtime,
    client: clientHandle,
    config,
    namespace,
    identity,
    taskQueue,
  })

  return { client, config }
}

class TemporalClientImpl implements TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly workflow: TemporalWorkflowClient

  private closed = false
  private readonly runtime: Runtime
  private readonly client: NativeClient
  private readonly defaultIdentity: string
  private readonly defaultTaskQueue: string

  constructor(handles: {
    runtime: Runtime
    client: NativeClient
    config: TemporalConfig
    namespace: string
    identity: string
    taskQueue: string
  }) {
    this.runtime = handles.runtime
    this.client = handles.client
    this.config = handles.config
    this.namespace = handles.namespace
    this.defaultIdentity = handles.identity
    this.defaultTaskQueue = handles.taskQueue
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
    const parsed = startWorkflowOptionsSchema.parse(options)
    const payload = buildStartWorkflowRequest({
      options: parsed as unknown as StartWorkflowOptions,
      defaults: {
        namespace: this.namespace,
        identity: this.defaultIdentity,
        taskQueue: this.defaultTaskQueue,
      },
    })

    const bytes = await native.startWorkflow(this.client, payload)
    const response = parseJson(bytes)
    const metadata = startWorkflowMetadataSchema.parse(response) as unknown as WorkflowHandleMetadata
    return toStartWorkflowResult(metadata)
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void> {
    const parsedHandle = workflowHandleSchema.parse(handle)
    const resolvedHandle: WorkflowHandle = {
      workflowId: parsedHandle.workflowId,
      namespace: parsedHandle.namespace ?? this.namespace,
      runId: parsedHandle.runId,
      firstExecutionRunId: parsedHandle.firstExecutionRunId,
    }

    const identity = this.defaultIdentity
    const entropy = createSignalRequestEntropy()
    const requestId = computeSignalRequestId(
      {
        namespace: resolvedHandle.namespace,
        workflowId: resolvedHandle.workflowId,
        runId: resolvedHandle.runId,
        firstExecutionRunId: resolvedHandle.firstExecutionRunId,
        signalName,
        identity,
        args,
      },
      { entropy },
    )

    const request = buildSignalRequest({
      handle: resolvedHandle,
      signalName,
      args,
      identity,
      requestId,
    })
    await native.signalWorkflow(this.client, request)
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown> {
    const parsedHandle = workflowHandleSchema.parse(handle)
    const resolvedHandle: WorkflowHandle = {
      workflowId: parsedHandle.workflowId,
      namespace: parsedHandle.namespace ?? this.namespace,
      runId: parsedHandle.runId,
      firstExecutionRunId: parsedHandle.firstExecutionRunId,
    }

    const parsedQueryName = workflowQueryNameSchema.parse(queryName)
    const request = buildQueryRequest(resolvedHandle, parsedQueryName, args)
    const bytes = await native.queryWorkflow(this.client, request)
    return parseJson(bytes)
  }

  async terminateWorkflow(handle: WorkflowHandle, options: TerminateWorkflowOptions = {}): Promise<void> {
    const parsedOptions = terminateWorkflowOptionsSchema.parse(options)
    const request = buildTerminateRequest(handle, parsedOptions)
    await native.terminateWorkflow(this.client, request)
  }

  async cancelWorkflow(handle: WorkflowHandle): Promise<void> {
    const request = buildCancelRequest(handle)
    await native.cancelWorkflow(this.client, request)
  }

  async signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult> {
    const request = buildSignalWithStartRequest({
      options,
      defaults: {
        namespace: this.namespace,
        identity: this.defaultIdentity,
        taskQueue: this.defaultTaskQueue,
      },
    })
    const bytes = await native.signalWithStart(this.client, request)
    const response = parseJson(bytes)
    const metadata = startWorkflowMetadataSchema.parse(response) as unknown as WorkflowHandleMetadata
    return toStartWorkflowResult(metadata)
  }

  async describeNamespace(targetNamespace?: string): Promise<Uint8Array> {
    return native.describeNamespace(this.client, targetNamespace ?? this.namespace)
  }

  async updateHeaders(headers: ClientHeaderInput): Promise<void> {
    if (this.closed) {
      throw new Error('Temporal client has already been shut down')
    }

    const parsed = metadataHeadersSchema.parse(headers)
    native.updateClientHeaders(this.client, parsed)
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    native.clientShutdown(this.client)
    native.runtimeShutdown(this.runtime)
  }
}

const parseJson = (bytes: Uint8Array): unknown => {
  const text = textDecoder.decode(bytes)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Failed to parse Temporal bridge response: ${(error as Error).message}`)
  }
}

const formatTemporalAddress = (address: string, useTls: boolean): string => {
  if (/^https?:\/\//i.test(address)) {
    return address
  }
  return `${useTls ? 'https' : 'http'}://${address}`
}

const serializeTlsConfig = (tls?: TLSConfig): Record<string, unknown> | undefined => {
  if (!tls) return undefined

  const payload: Record<string, unknown> = {}
  const encode = (buffer?: Buffer) => buffer?.toString('base64')

  const caCertificate = encode(tls.serverRootCACertificate)
  if (caCertificate) {
    payload.serverRootCACertificate = caCertificate
    payload.server_root_ca_cert = caCertificate
  }

  const clientCert = encode(tls.clientCertPair?.crt)
  const clientPrivateKey = encode(tls.clientCertPair?.key)
  if (clientCert && clientPrivateKey) {
    const pair = { crt: clientCert, key: clientPrivateKey }
    payload.clientCertPair = pair
    payload.client_cert_pair = pair
    payload.client_cert = clientCert
    payload.client_private_key = clientPrivateKey
  }

  if (tls.serverNameOverride) {
    payload.serverNameOverride = tls.serverNameOverride
    payload.server_name_override = tls.serverNameOverride
  }

  if (Object.keys(payload).length === 0) {
    return undefined
  }

  return payload
}

export type {
  RetryPolicyOptions,
  SignalWithStartOptions,
  StartWorkflowOptions,
  StartWorkflowResult,
  TerminateWorkflowOptions,
  WorkflowHandle,
  WorkflowHandleMetadata,
} from './client/types'
export { createWorkflowHandle } from './client/types'
