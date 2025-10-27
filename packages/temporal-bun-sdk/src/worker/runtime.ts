import { Buffer } from 'node:buffer'
import { temporal } from '@temporalio/proto'
import { loadTemporalConfig, type TemporalConfig, type TLSConfig } from '../config'
import {
  NativeBridgeError,
  type NativeClient,
  type Runtime as NativeRuntime,
  type NativeWorker,
  native,
} from '../internal/core-bridge/native'

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'

const shouldUseZigWorkerBridge = (): boolean => process.env.TEMPORAL_BUN_SDK_USE_ZIG === '1'

export interface WorkerRuntimeOptions {
  workflowsPath: string
  activities?: Record<string, (...args: unknown[]) => unknown>
  taskQueue?: string
  namespace?: string
  concurrency?: { workflow?: number; activity?: number }
}

export interface NativeWorkerOptions {
  runtime: NativeRuntime
  client: NativeClient
  namespace?: string
  taskQueue?: string
  identity?: string
}

export const isZigWorkerBridgeEnabled = (): boolean => shouldUseZigWorkerBridge() && native.bridgeVariant === 'zig'

export const maybeCreateNativeWorker = (options: NativeWorkerOptions): NativeWorker | null => {
  if (!shouldUseZigWorkerBridge()) {
    return null
  }

  if (native.bridgeVariant !== 'zig') {
    throw new NativeBridgeError({
      code: 2,
      message: 'TEMPORAL_BUN_SDK_USE_ZIG=1 requires the Zig bridge, but a different native bridge variant was loaded.',
      details: { bridgeVariant: native.bridgeVariant },
    })
  }

  const namespace = (options.namespace ?? DEFAULT_NAMESPACE).trim()
  if (namespace.length === 0) {
    throw new NativeBridgeError({
      code: 3,
      message: 'Worker namespace must be a non-empty string when TEMPORAL_BUN_SDK_USE_ZIG=1',
    })
  }

  const taskQueue = options.taskQueue?.trim()
  if (!taskQueue) {
    throw new NativeBridgeError({
      code: 3,
      message: 'Worker taskQueue is required when TEMPORAL_BUN_SDK_USE_ZIG=1',
    })
  }

  const identity = options.identity?.trim().length
    ? options.identity.trim()
    : `${DEFAULT_IDENTITY_PREFIX}-${process.pid}`

  try {
    return native.createWorker(options.runtime, options.client, {
      namespace,
      taskQueue,
      identity,
    })
  } catch (error) {
    if (error instanceof NativeBridgeError) {
      throw error
    }
    throw new NativeBridgeError({ message: error instanceof Error ? error.message : String(error) })
  }
}

export const destroyNativeWorker = (worker: NativeWorker | null | undefined): void => {
  if (!worker) {
    return
  }
  native.destroyWorker(worker)
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
  const clientKey = encode(tls.clientCertPair?.key)
  if (clientCert && clientKey) {
    const pair = { crt: clientCert, key: clientKey }
    payload.clientCertPair = pair
    payload.client_cert_pair = pair
    payload.client_cert = clientCert
    payload.client_private_key = clientKey
  }

  if (tls.serverNameOverride) {
    payload.serverNameOverride = tls.serverNameOverride
    payload.server_name_override = tls.serverNameOverride
  }

  return Object.keys(payload).length === 0 ? undefined : payload
}

type WorkerRuntimeState = 'idle' | 'running' | 'stopping' | 'stopped'

interface WorkerHandles {
  runtime: NativeRuntime
  client: NativeClient
  worker: NativeWorker
}

interface WorkerRuntimeContext {
  namespace: string
  identity: string
  taskQueue: string
  config: TemporalConfig
}

export class WorkerRuntime {
  #handles: WorkerHandles
  #context: WorkerRuntimeContext
  #state: WorkerRuntimeState = 'idle'
  #abortController: AbortController | null = null
  #runPromise: Promise<void> | null = null
  #shutdownPromise: Promise<void> | null = null
  #resolveShutdown?: () => void
  #rejectShutdown?: (error: unknown) => void
  #nativeShutdownRequested = false
  #disposed = false

  private constructor(
    readonly options: WorkerRuntimeOptions,
    handles: WorkerHandles,
    context: WorkerRuntimeContext,
  ) {
    this.#handles = handles
    this.#context = context
  }

  static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
    if (!isZigWorkerBridgeEnabled()) {
      throw new NativeBridgeError({
        code: 2,
        message: 'WorkerRuntime.create requires TEMPORAL_BUN_SDK_USE_ZIG=1 and the Zig bridge.',
        details: { bridgeVariant: native.bridgeVariant },
      })
    }

    const config = await loadTemporalConfig()
    if (config.allowInsecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }

    const namespace = (options.namespace ?? config.namespace ?? DEFAULT_NAMESPACE).trim()
    if (namespace.length === 0) {
      throw new NativeBridgeError({
        code: 3,
        message: 'Worker namespace must be configured when using the Zig bridge.',
      })
    }

    const taskQueue = (options.taskQueue ?? config.taskQueue ?? '').trim()
    if (taskQueue.length === 0) {
      throw new NativeBridgeError({
        code: 3,
        message: 'Worker taskQueue must be configured when using the Zig bridge.',
      })
    }

    const identity = config.workerIdentity?.trim().length
      ? config.workerIdentity.trim()
      : `${DEFAULT_IDENTITY_PREFIX}-${process.pid}`

    const runtime = native.createRuntime({})
    let client: NativeClient | null = null

    try {
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

      client = await native.createClient(runtime, nativeConfig)

      const workerHandle = maybeCreateNativeWorker({
        runtime,
        client,
        namespace,
        taskQueue,
        identity,
      })

      if (!workerHandle) {
        throw new NativeBridgeError({
          code: 2,
          message: 'Zig worker bridge is disabled; set TEMPORAL_BUN_SDK_USE_ZIG=1 to enable WorkerRuntime.',
        })
      }

      return new WorkerRuntime(
        options,
        { runtime, client, worker: workerHandle },
        { namespace, identity, taskQueue, config },
      )
    } catch (error) {
      if (client) {
        native.clientShutdown(client)
      }
      native.runtimeShutdown(runtime)
      throw error
    }
  }

  async run(): Promise<void> {
    if (this.#state === 'stopped') {
      throw new Error('WorkerRuntime has already been shut down')
    }

    if (this.#state === 'running' || this.#state === 'stopping') {
      return this.#shutdownPromise ?? Promise.resolve()
    }

    this.#state = 'running'
    this.#nativeShutdownRequested = false
    this.#abortController = new AbortController()
    this.#shutdownPromise = new Promise<void>((resolve, reject) => {
      this.#resolveShutdown = resolve
      this.#rejectShutdown = reject
    })

    const signal = this.#abortController.signal
    const loopPromise = this.#workflowLoop(signal)

    this.#runPromise = loopPromise
      .then(() => {
        this.#disposeHandles()
        this.#state = 'stopped'
        this.#resolveShutdown?.()
      })
      .catch((error) => {
        this.#disposeHandles()
        this.#state = 'stopped'
        this.#rejectShutdown?.(error)
        throw error
      })
      .finally(() => {
        this.#resolveShutdown = undefined
        this.#rejectShutdown = undefined
        this.#shutdownPromise = null
      })

    return this.#shutdownPromise
  }

  async shutdown(_gracefulTimeoutMs?: number): Promise<void> {
    void _gracefulTimeoutMs

    if (this.#state === 'stopped') {
      return
    }

    if (this.#state === 'idle') {
      this.#disposeHandles()
      this.#state = 'stopped'
      return
    }

    if (this.#state === 'running' || this.#state === 'stopping') {
      this.#state = 'stopping'
      this.#abortController?.abort()
      this.#requestNativeShutdown()
      if (this.#runPromise) {
        await this.#runPromise.catch((error) => {
          throw error
        })
      }
    }
  }

  #requestNativeShutdown(): void {
    if (this.#disposed || this.#nativeShutdownRequested) {
      return
    }

    if (!this.#handles.worker.handle) {
      this.#nativeShutdownRequested = true
      return
    }

    this.#nativeShutdownRequested = true

    try {
      destroyNativeWorker(this.#handles.worker)
    } catch (error) {
      this.#nativeShutdownRequested = false
      throw error
    }
  }

  async #workflowLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let payload: Uint8Array
      try {
        payload = await native.worker.pollWorkflowTask(this.#handles.worker)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        throw error
      }

      if (signal.aborted) {
        break
      }

      if (payload.byteLength === 0) {
        continue
      }

      this.#acknowledgeActivation(payload)
    }
  }

  #acknowledgeActivation(bytes: Uint8Array): void {
    let activation: temporal.api.workflowservice.v1.PollWorkflowTaskQueueResponse
    try {
      activation = temporal.api.workflowservice.v1.PollWorkflowTaskQueueResponse.decode(bytes)
    } catch (error) {
      throw new Error(`Failed to decode workflow activation: ${(error as Error).message}`)
    }

    const token = activation.taskToken
    if (!token || token.length === 0) {
      throw new Error('Received workflow activation without a task token')
    }

    const completionRequest = temporal.api.workflowservice.v1.RespondWorkflowTaskCompletedRequest.encode({
      taskToken: token,
      identity: this.#context.identity,
      namespace: this.#context.namespace,
      commands: [],
    }).finish()

    native.workerCompleteWorkflowTask(this.#handles.worker, Buffer.from(completionRequest))
  }

  #disposeHandles(): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#nativeShutdownRequested = true

    if (this.#handles.worker.handle) {
      destroyNativeWorker(this.#handles.worker)
    }
    native.clientShutdown(this.#handles.client)
    native.runtimeShutdown(this.#handles.runtime)
  }
}
