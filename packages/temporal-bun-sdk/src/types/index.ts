// Strict type definitions for @proompteng/temporal-bun-sdk

// Core types
export interface TemporalPayload {
  readonly data: Uint8Array
  readonly metadata: Record<string, string>
}

export interface WorkflowHandle {
  readonly workflowId: string
  readonly runId: string
  readonly firstExecutionRunId?: string
  readonly namespace: string
}

export interface ClientConfig {
  readonly address: string
  readonly namespace: string
  readonly apiKey?: string
  readonly tls?: {
    readonly serverRootCACert?: Uint8Array
    readonly clientCert?: Uint8Array
    readonly clientPrivateKey?: Uint8Array
    readonly serverName?: string
  }
}

export interface TemporalClientConfig {
  readonly address?: string
  readonly namespace?: string
  readonly apiKey?: string
  readonly identity?: string
  readonly tls?: {
    readonly caPath?: string
    readonly certPath?: string
    readonly keyPath?: string
    readonly serverName?: string
  }
  readonly dataConverter?: {
    readonly payloadCodec?: PayloadCodec
  }
}

export interface WorkflowStartOptions {
  readonly workflowId: string
  readonly workflowType: string
  readonly taskQueue: string
  readonly args?: unknown[]
  readonly namespace?: string
  readonly identity?: string
  readonly memo?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly cronSchedule?: string
  readonly workflowExecutionTimeout?: string
  readonly workflowRunTimeout?: string
  readonly workflowTaskTimeout?: string
  readonly retryPolicy?: RetryPolicy
}

export interface RetryPolicy {
  readonly initialInterval?: string
  readonly backoffCoefficient?: number
  readonly maximumInterval?: string
  readonly maximumAttempts?: number
  readonly nonRetryableErrorTypes?: string[]
}

export interface WorkerConfig {
  readonly taskQueue: string
  readonly namespace?: string
  readonly workflowsPath: string
  readonly activities?: Record<string, (...args: unknown[]) => unknown>
  readonly concurrency?: {
    readonly workflow?: number
    readonly activity?: number
  }
  readonly interceptors?: InterceptorManager
}

export interface RuntimeOptions {
  readonly telemetry?: {
    readonly prometheus?: {
      readonly bindAddress?: string
    }
    readonly otlp?: {
      readonly endpoint?: string
    }
  }
  readonly logging?: {
    readonly level?: string
    readonly forwardTo?: (level: string, message: string) => void
  }
  readonly metrics?: {
    readonly prometheus?: {
      readonly bindAddress?: string
    }
    readonly otlp?: {
      readonly endpoint?: string
    }
  }
}

// Workflow types
export interface WorkflowActivation {
  readonly runId: string
  readonly workflowId: string
  readonly workflowType: string
  readonly taskQueue: string
  readonly namespace: string
  readonly input?: unknown
  readonly history?: unknown[]
  readonly signals?: unknown[]
  readonly queries?: unknown[]
  readonly patches?: unknown[]
}

export interface WorkflowCompletion {
  readonly result?: unknown
  readonly error?: string
}

export interface WorkflowContext {
  readonly workflowId: string
  readonly runId: string
  readonly workflowType: string
  readonly taskQueue: string
  readonly namespace: string
  readonly input?: unknown
  readonly history?: unknown[]
  readonly signals?: unknown[]
  readonly queries?: unknown[]
  readonly patches?: unknown[]
}

// Worker types
export interface WorkflowTask {
  readonly id: string
  readonly workflowId: string
  readonly runId: string
  readonly workflowType: string
  readonly taskQueue: string
  readonly namespace: string
  readonly activation: unknown
}

export interface ActivityTask {
  readonly id: string
  readonly activityId: string
  readonly activityType: string
  readonly taskQueue: string
  readonly namespace: string
  readonly input: unknown[]
}

// Interceptor types
export interface WorkflowInterceptor {
  readonly execute?: (input: unknown) => Promise<unknown>
  readonly signal?: (signalName: string, args: unknown[]) => Promise<void>
  readonly query?: (queryName: string, args: unknown[]) => Promise<unknown>
}

export interface ActivityInterceptor {
  readonly execute?: (activityName: string, args: unknown[]) => Promise<unknown>
  readonly executeActivity?: (activityName: string, args: unknown[]) => Promise<unknown[]>
}

export interface InterceptorManager {
  readonly addWorkflowInterceptor: (interceptor: WorkflowInterceptor) => void
  readonly addActivityInterceptor: (interceptor: ActivityInterceptor) => void
  readonly removeWorkflowInterceptor: (interceptor: WorkflowInterceptor) => void
  readonly removeActivityInterceptor: (interceptor: ActivityInterceptor) => void
  readonly getWorkflowInterceptors: () => WorkflowInterceptor[]
  readonly getActivityInterceptors: () => ActivityInterceptor[]
}

// Bundle types
export interface WorkflowBundle {
  readonly workflows: Record<string, string>
  readonly activities?: Record<string, string>
  readonly metadata: {
    readonly version: string
    readonly createdAt: string
    readonly platform: string
  }
}

export interface BundleOptions {
  readonly workflowsPath: string
  readonly outputPath: string
  readonly includeActivities?: boolean
  readonly minify?: boolean
  readonly sourceMap?: boolean
}

export interface StaticLibrary {
  readonly name: string
  readonly path: string
  readonly checksum: string
}

export interface LibrarySet {
  readonly platform: string
  readonly architecture: string
  readonly version: string
  readonly libraries: StaticLibrary[]
}

export interface PlatformInfo {
  readonly os: 'linux' | 'macos' | 'windows'
  readonly arch: 'arm64' | 'x64'
  readonly platform: string
}

// Native bridge types
export interface FFIFunctionDefinition {
  readonly args: string[]
  readonly returns: string
}

export interface FFIFunctions {
  [key: string]: FFIFunctionDefinition
}

export interface NativeBridge {
  [key: string]: (...args: unknown[]) => unknown
}

// Error types
export class TemporalError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = 'TemporalError'
  }
}

export class NativeBridgeError extends TemporalError {
  constructor(message: string, cause?: Error) {
    super(message, 'NATIVE_BRIDGE_ERROR', cause)
    this.name = 'NativeBridgeError'
  }
}

export class WorkflowError extends TemporalError {
  constructor(message: string, cause?: Error) {
    super(message, 'WORKFLOW_ERROR', cause)
    this.name = 'WorkflowError'
  }
}

export class ActivityError extends TemporalError {
  constructor(message: string, cause?: Error) {
    super(message, 'ACTIVITY_ERROR', cause)
    this.name = 'ActivityError'
  }
}

// Utility types
export type NonEmptyArray<T> = [T, ...T[]]

export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P]
}

export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>

export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

// Payload codec interface
export interface PayloadCodec {
  readonly encode: (value: unknown) => TemporalPayload
  readonly decode: (payload: TemporalPayload) => unknown
}
