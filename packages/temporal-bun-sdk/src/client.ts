import { z } from 'zod'
import {
  buildCancelRequest,
  buildQueryRequest,
  buildSignalRequest,
  buildSignalWithStartRequest,
  buildStartWorkflowRequest,
  buildTerminateRequest,
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

const metadataHeadersSchema = z
  .record(z.string(), z.string().trim().min(1, 'Header values must be non-empty strings'))
  .superRefine((headers, ctx) => {
    const seen = new Set<string>()
    for (const key of Object.keys(headers)) {
      const trimmedKey = key.trim()
      if (trimmedKey.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header keys must be non-empty strings',
          path: [key],
        })
        continue
      }

      if (trimmedKey !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header keys must not include leading or trailing whitespace',
          path: [key],
        })
      }

      const normalizedKey = trimmedKey.toLowerCase()
      if (seen.has(normalizedKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Header key '${normalizedKey}' is duplicated (case-insensitive match)`,
          path: [key],
        })
      } else {
        seen.add(normalizedKey)
      }
    }
  })
  .transform((headers) => {
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      normalized[key.trim().toLowerCase()] = value
    }
    return normalized
  })

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
  updateHeaders(headers: Record<string, string>): Promise<void>
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
  const nativeConfig: Record<string, unknown> = {
    address: formatTemporalAddress(config.address, Boolean(config.tls)),
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
      options: parsed,
      defaults: {
        namespace: this.namespace,
        identity: this.defaultIdentity,
        taskQueue: this.defaultTaskQueue,
      },
    })

    const bytes = await native.startWorkflow(this.client, payload)
    const response = parseJson(bytes)
    const metadata = startWorkflowMetadataSchema.parse(response)
    return toStartWorkflowResult(metadata)
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void> {
    const request = buildSignalRequest(handle, signalName, args)
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
    const metadata = startWorkflowMetadataSchema.parse(response)
    return toStartWorkflowResult(metadata)
  }

  async describeNamespace(targetNamespace?: string): Promise<Uint8Array> {
    return native.describeNamespace(this.client, targetNamespace ?? this.namespace)
  }

  async updateHeaders(headers: Record<string, string>): Promise<void> {
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
