import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Pointer = number

type RuntimePtr = Pointer

type ClientPtr = Pointer

export interface Runtime {
  type: 'runtime'
  handle: RuntimePtr
}

export interface NativeClient {
  type: 'client'
  handle: ClientPtr
}

type BridgeVariant = 'zig' | 'rust'

export interface ByteArrayTelemetrySnapshot {
  readonly totalAllocations: number
  readonly currentAllocations: number
  readonly totalBytes: number
  readonly currentBytes: number
  readonly allocationFailures: number
  readonly maxAllocationSize: number
}

export interface ByteArrayTelemetryMetrics {
  readonly counters: Record<string, number>
  readonly gauges: Record<string, number>
  readonly histograms: Record<string, readonly number[]>
}

export interface ByteArrayTelemetry {
  readonly supported: boolean
  snapshot(): ByteArrayTelemetrySnapshot
  reset(): ByteArrayTelemetrySnapshot
  metrics(): ByteArrayTelemetryMetrics
  subscribe(listener: (snapshot: ByteArrayTelemetrySnapshot) => void): () => void
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolvePackageRoot()
const distNativeDir = join(packageRoot, 'dist', 'native')
const zigStageLibDir = join(packageRoot, 'native', 'temporal-bun-bridge-zig', 'zig-out', 'lib')
const rustBridgeTargetDir = join(packageRoot, 'native', 'temporal-bun-bridge', 'target')

const { module: nativeModule, path: libraryFile, variant: resolvedBridgeVariant } = loadBridgeLibrary()

export const bridgeVariant = resolvedBridgeVariant
export const isZigBridge = resolvedBridgeVariant === 'zig'

const UNKNOWN_NATIVE_ERROR_CODE = 2

export interface NativeBridgeErrorInit {
  code: number
  message: string
  details?: unknown
  raw?: string
}

export class NativeBridgeError extends Error {
  readonly code: number
  readonly details?: unknown
  readonly raw: string

  constructor(input: string | NativeBridgeErrorInit) {
    const payload: NativeBridgeErrorInit =
      typeof input === 'string'
        ? { code: UNKNOWN_NATIVE_ERROR_CODE, message: input, raw: input }
        : {
            code: input.code ?? UNKNOWN_NATIVE_ERROR_CODE,
            message: input.message ?? 'Unknown native error',
            details: input.details,
            raw: input.raw ?? input.message,
          }
    const message = payload.message ?? 'Unknown native error'
    super(message)
    this.name = 'NativeBridgeError'
    this.code = payload.code
    this.details = payload.details
    this.raw = payload.raw ?? message
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

type ZigPreference = 'auto' | 'enable' | 'disable'

interface BridgeLibraryLoadResult {
  module: ReturnType<typeof dlopen>
  path: string
  variant: BridgeVariant
}

interface BridgeLoadErrorContext {
  variant: BridgeVariant
  preference: ZigPreference
  override: boolean
}

type SymbolConfig = Record<string, { readonly args: readonly FFIType[]; readonly returns: FFIType }>

function loadBridgeLibrary(): BridgeLibraryLoadResult {
  const override = process.env.TEMPORAL_BUN_SDK_NATIVE_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`Temporal Bun bridge override not found at ${override}`)
    }
    const variant = detectBridgeVariantFromPath(override)
    try {
      return {
        module: dlopen(override, buildBridgeSymbolMap(variant)),
        path: override,
        variant,
      }
    } catch (error) {
      throw buildBridgeLoadError(override, error, {
        variant,
        preference: 'enable',
        override: true,
      })
    }
  }

  const preference = getZigPreference()
  const candidates = resolveBridgeLibraryCandidates(preference)

  let lastError: unknown = null
  let lastCandidate: ResolvedBridgeCandidate | null = null

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]

    let candidatePath: string
    try {
      candidatePath = candidate.resolvePath()
    } catch (error) {
      lastError = error

      if (candidate.variant === 'zig') {
        const nextVariant = candidates[index + 1]?.variant ?? null
        logZigBridgeLoadFailure('(failed to resolve Zig bridge path)', error, nextVariant)
        continue
      }

      throw error instanceof Error ? error : new Error(String(error))
    }

    const symbolMap = buildBridgeSymbolMap(candidate.variant)

    try {
      return {
        module: dlopen(candidatePath, symbolMap),
        path: candidatePath,
        variant: candidate.variant,
      }
    } catch (error) {
      lastError = error
      lastCandidate = { path: candidatePath, variant: candidate.variant }

      if (candidate.variant === 'zig') {
        const nextVariant = candidates[index + 1]?.variant ?? null
        logZigBridgeLoadFailure(candidatePath, error, nextVariant)
        continue
      }

      throw buildBridgeLoadError(candidatePath, error, {
        variant: candidate.variant,
        preference,
        override: false,
      })
    }
  }

  if (lastCandidate) {
    throw buildBridgeLoadError(lastCandidate.path, lastError, {
      variant: lastCandidate.variant,
      preference,
      override: false,
    })
  }

  throw new NativeBridgeError('No Temporal Bun bridge candidates were resolved.')
}

function buildBridgeSymbolMap(variant: BridgeVariant): SymbolConfig {
  const map: SymbolConfig = {
    temporal_bun_runtime_new: {
      args: [FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_runtime_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    temporal_bun_error_message: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    temporal_bun_error_free: {
      args: [FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.void,
    },
    temporal_bun_client_connect_async: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    temporal_bun_client_describe_namespace_async: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_update_headers: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.int32_t,
    },
    temporal_bun_pending_client_poll: {
      args: [FFIType.ptr],
      returns: FFIType.int32_t,
    },
    temporal_bun_pending_client_consume: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    temporal_bun_pending_client_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    temporal_bun_pending_byte_array_poll: {
      args: [FFIType.ptr],
      returns: FFIType.int32_t,
    },
    temporal_bun_pending_byte_array_consume: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    temporal_bun_pending_byte_array_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    temporal_bun_byte_array_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    temporal_bun_client_start_workflow: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_terminate_workflow: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.int32_t,
    },
    temporal_bun_client_signal_with_start: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_query_workflow: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
  }

  if (variant === 'zig') {
    map.temporal_bun_client_signal = {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    }
    map.temporal_bun_client_cancel_workflow = {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    }
    map.temporal_bun_byte_array_metrics_snapshot = {
      args: [FFIType.ptr],
      returns: FFIType.void,
    }
    map.temporal_bun_byte_array_metrics_reset = {
      args: [],
      returns: FFIType.void,
    }
  }

  return map
}

function detectBridgeVariantFromPath(candidate: string): BridgeVariant {
  return /temporal[-_]bun[-_]bridge[-_]zig/.test(candidate) ? 'zig' : 'rust'
}

function logZigBridgeLoadFailure(candidate: string, error: unknown, nextVariant: BridgeVariant | null): void {
  const reason = error instanceof Error ? error.message : String(error)
  let followUp = 'No additional bridge candidates are available.'
  if (nextVariant === 'zig') {
    followUp = 'Attempting the next Zig bridge candidate.'
  } else if (nextVariant === 'rust') {
    followUp = 'Falling back to the Rust bridge.'
  }
  console.warn(`Failed to load Zig bridge at ${candidate}. ${followUp}\nReason: ${reason}`, error)
}

function buildBridgeLoadError(libraryPath: string, error: unknown, context: BridgeLoadErrorContext): Error {
  const reason = error instanceof Error ? error.message : String(error)
  const messages = [`Failed to load Temporal Bun bridge at ${libraryPath}`]
  if (reason) {
    messages.push(`Reason: ${reason}`)
  }

  if (context.override) {
    messages.push('Verify TEMPORAL_BUN_SDK_NATIVE_PATH or rebuild the specified library for this platform.')
  } else if (context.variant === 'zig' && context.preference === 'enable') {
    messages.push('TEMPORAL_BUN_SDK_USE_ZIG=1 requires a compatible Zig bridge; disable the flag to fall back to Rust.')
  } else if (context.variant === 'rust') {
    messages.push('Did you run `cargo build -p temporal-bun-bridge`?')
  }

  const failure = new NativeBridgeError(messages.join('. '))
  ;(failure as Error & { cause?: unknown }).cause = error
  return failure
}

const {
  symbols: {
    temporal_bun_runtime_new,
    temporal_bun_runtime_free,
    temporal_bun_error_message,
    temporal_bun_error_free,
    temporal_bun_client_connect_async,
    temporal_bun_client_free,
    temporal_bun_client_describe_namespace_async,
    temporal_bun_client_update_headers,
    temporal_bun_pending_client_poll,
    temporal_bun_pending_client_consume,
    temporal_bun_pending_client_free,
    temporal_bun_pending_byte_array_poll,
    temporal_bun_pending_byte_array_consume,
    temporal_bun_pending_byte_array_free,
    temporal_bun_byte_array_free,
    temporal_bun_client_start_workflow,
    temporal_bun_client_terminate_workflow,
    temporal_bun_client_signal,
    temporal_bun_client_signal_with_start,
    temporal_bun_client_query_workflow,
    temporal_bun_client_cancel_workflow,
    temporal_bun_byte_array_metrics_snapshot,
    temporal_bun_byte_array_metrics_reset,
  },
} = nativeModule

const BYTE_ARRAY_METRICS_WORDS = 6
const BYTE_ARRAY_METRICS_SIZE = BYTE_ARRAY_METRICS_WORDS * 8

const ZERO_BYTE_ARRAY_TELEMETRY: ByteArrayTelemetrySnapshot = {
  totalAllocations: 0,
  currentAllocations: 0,
  totalBytes: 0,
  currentBytes: 0,
  allocationFailures: 0,
  maxAllocationSize: 0,
}

const byteArrayMetricsBuffer = Buffer.alloc(BYTE_ARRAY_METRICS_SIZE)
const byteArrayTelemetryListeners = new Set<(snapshot: ByteArrayTelemetrySnapshot) => void>()

function readByteArrayTelemetrySnapshot(): ByteArrayTelemetrySnapshot {
  if (!temporal_bun_byte_array_metrics_snapshot) {
    return ZERO_BYTE_ARRAY_TELEMETRY
  }

  byteArrayMetricsBuffer.fill(0)
  temporal_bun_byte_array_metrics_snapshot(ptr(byteArrayMetricsBuffer))
  const view = new BigUint64Array(
    byteArrayMetricsBuffer.buffer,
    byteArrayMetricsBuffer.byteOffset,
    BYTE_ARRAY_METRICS_WORDS,
  )

  return {
    totalAllocations: Number(view[0]),
    currentAllocations: Number(view[1]),
    totalBytes: Number(view[2]),
    currentBytes: Number(view[3]),
    allocationFailures: Number(view[4]),
    maxAllocationSize: Number(view[5]),
  }
}

function dispatchByteArrayTelemetrySnapshot(): ByteArrayTelemetrySnapshot {
  const snapshot = readByteArrayTelemetrySnapshot()
  for (const listener of byteArrayTelemetryListeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.error('temporal-bun-bridge byte array telemetry listener failed', error)
    }
  }
  return snapshot
}

function buildByteArrayTelemetryMetrics(snapshot: ByteArrayTelemetrySnapshot): ByteArrayTelemetryMetrics {
  return {
    counters: {
      'temporal.byte_array.allocations.total': snapshot.totalAllocations,
      'temporal.byte_array.bytes.total': snapshot.totalBytes,
      'temporal.byte_array.failures.total': snapshot.allocationFailures,
    },
    gauges: {
      'temporal.byte_array.allocations.current': snapshot.currentAllocations,
      'temporal.byte_array.bytes.current': snapshot.currentBytes,
    },
    histograms: {
      'temporal.byte_array.max_allocation.bytes': [snapshot.maxAllocationSize],
    },
  }
}

const byteArrayTelemetry: ByteArrayTelemetry = {
  supported: Boolean(temporal_bun_byte_array_metrics_snapshot),
  snapshot: dispatchByteArrayTelemetrySnapshot,
  reset(): ByteArrayTelemetrySnapshot {
    temporal_bun_byte_array_metrics_reset?.()
    return dispatchByteArrayTelemetrySnapshot()
  },
  metrics(): ByteArrayTelemetryMetrics {
    return buildByteArrayTelemetryMetrics(readByteArrayTelemetrySnapshot())
  },
  subscribe(listener: (snapshot: ByteArrayTelemetrySnapshot) => void): () => void {
    byteArrayTelemetryListeners.add(listener)
    return () => {
      byteArrayTelemetryListeners.delete(listener)
    }
  },
}

export const native = {
  bridgeVariant: resolvedBridgeVariant,
  byteArrayTelemetry,

  createRuntime(options: Record<string, unknown> = {}): Runtime {
    const payload = Buffer.from(JSON.stringify(options), 'utf8')
    const handle = Number(temporal_bun_runtime_new(ptr(payload), payload.byteLength))
    if (!handle) {
      throw buildNativeBridgeError()
    }
    return { type: 'runtime', handle }
  },

  runtimeShutdown(runtime: Runtime): void {
    temporal_bun_runtime_free(runtime.handle)
  },

  async createClient(runtime: Runtime, config: Record<string, unknown>): Promise<NativeClient> {
    const payload = Buffer.from(JSON.stringify(config), 'utf8')
    const pendingHandle = Number(temporal_bun_client_connect_async(runtime.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      const handle = await waitForClientHandle(pendingHandle)
      return { type: 'client', handle }
    } finally {
      temporal_bun_pending_client_free(pendingHandle)
    }
  },

  clientShutdown(client: NativeClient): void {
    temporal_bun_client_free(client.handle)
  },

  async describeNamespace(client: NativeClient, namespace: string): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify({ namespace }), 'utf8')
    const pendingHandle = Number(
      temporal_bun_client_describe_namespace_async(client.handle, ptr(payload), payload.byteLength),
    )
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      return await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async startWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const arrayPtr = Number(temporal_bun_client_start_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!arrayPtr) {
      throw buildNativeBridgeError()
    }
    return readByteArray(arrayPtr)
  },

  configureTelemetry(runtime: Runtime, options: Record<string, unknown> = {}): never {
    void runtime
    void options
    // TODO(codex): Bridge telemetry configuration through `temporal_bun_runtime_update_telemetry`
    // per packages/temporal-bun-sdk/docs/ffi-surface.md (Function Matrix, Runtime section).
    return notImplemented('Runtime telemetry configuration', 'docs/ffi-surface.md')
  },

  installLogger(runtime: Runtime, _callback: (...args: unknown[]) => void): never {
    void runtime
    // TODO(codex): Install Bun logger hook via `temporal_bun_runtime_set_logger` once the native bridge
    // supports forwarding core logs (docs/ffi-surface.md — Runtime exports).
    return notImplemented('Runtime logger installation', 'docs/ffi-surface.md')
  },

  updateClientHeaders(client: NativeClient, headers: Record<string, string>): void {
    const payload = Buffer.from(JSON.stringify(headers ?? {}), 'utf8')
    const status = Number(temporal_bun_client_update_headers(client.handle, ptr(payload), payload.byteLength))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  async signalWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<void> {
    if (!temporal_bun_client_signal) {
      return Promise.reject(buildNotImplementedError('Workflow signal bridge', 'docs/ffi-surface.md'))
    }

    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_signal(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw new Error(readLastError())
    }
    try {
      await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async queryWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_query_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      return await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async terminateWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<void> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const status = Number(temporal_bun_client_terminate_workflow(client.handle, ptr(payload), payload.byteLength))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  async cancelWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<void> {
    if (!temporal_bun_client_cancel_workflow) {
      return Promise.reject(buildNotImplementedError('Workflow cancel bridge', 'docs/ffi-surface.md'))
    }

    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_cancel_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw new Error(readLastError())
    }
    try {
      await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async signalWithStart(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const arrayPtr = Number(temporal_bun_client_signal_with_start(client.handle, ptr(payload), payload.byteLength))
    if (!arrayPtr) {
      throw buildNativeBridgeError()
    }
    return readByteArray(arrayPtr)
  },
}

function resolvePackageRoot(): string {
  let dir = moduleDir
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      return dir
    }
    dir = join(dir, '..')
  }
  return join(moduleDir, '..', '..', '..', '..', '..')
}

interface ZigLookupResult {
  path: string | null
  attempted: string[]
}

interface BridgeResolution {
  resolvePath: () => string
  variant: BridgeVariant
}

interface ResolvedBridgeCandidate {
  path: string
  variant: BridgeVariant
}

function resolveBridgeLibraryCandidates(preference: ZigPreference): BridgeResolution[] {
  const candidates: BridgeResolution[] = []
  const attemptedZigPaths: string[] = []

  if (preference !== 'disable') {
    const packaged = resolvePackagedZigBridgeLibraryPath()
    attemptedZigPaths.push(...packaged.attempted)
    if (packaged.path) {
      const zigPackagedPath = packaged.path
      candidates.push({ resolvePath: () => zigPackagedPath, variant: 'zig' })
    }

    const local = resolveLocalZigBridgeLibraryPath()
    attemptedZigPaths.push(...local.attempted)
    if (local.path) {
      const zigLocalPath = local.path
      candidates.push({ resolvePath: () => zigLocalPath, variant: 'zig' })
    }

    if (attemptedZigPaths.length > 0 && !candidates.some((candidate) => candidate.variant === 'zig')) {
      if (preference === 'enable') {
        logMissingZigBridge(
          attemptedZigPaths,
          'TEMPORAL_BUN_SDK_USE_ZIG was enabled but no Zig bridge artefacts were found. Falling back to the Rust bridge.',
        )
      } else {
        logMissingZigBridge(
          attemptedZigPaths,
          'No Zig bridge binary was located for this platform. Falling back to the Rust bridge.',
        )
      }
    }
  }

  const hasZigCandidate = candidates.some((candidate) => candidate.variant === 'zig')
  if (!hasZigCandidate) {
    candidates.push({ resolvePath: () => resolveRustBridgeLibraryPath(), variant: 'rust' })
    return candidates
  }

  if (preference !== 'enable') {
    candidates.push({ resolvePath: () => resolveRustBridgeLibraryPath(), variant: 'rust' })
  }

  return candidates
}

function getZigPreference(): ZigPreference {
  const flag = process.env.TEMPORAL_BUN_SDK_USE_ZIG
  if (!flag) {
    return 'auto'
  }
  if (/^(0|false|off)$/i.test(flag)) {
    return 'disable'
  }
  if (/^(1|true|on)$/i.test(flag)) {
    return 'enable'
  }
  return 'enable'
}

function resolvePackagedZigBridgeLibraryPath(): ZigLookupResult {
  const attempted: string[] = []
  const platform = getRuntimePlatform()
  const arch = getRuntimeArch()
  if (!platform || !arch) {
    return { path: null, attempted }
  }

  const releaseName = getZigReleaseLibraryName()
  const packagedPath = join(distNativeDir, platform, arch, releaseName)
  attempted.push(packagedPath)
  if (existsSync(packagedPath)) {
    return { path: packagedPath, attempted }
  }

  return { path: null, attempted }
}

function resolveLocalZigBridgeLibraryPath(): ZigLookupResult {
  const attempted: string[] = []
  const platform = getRuntimePlatform()
  const arch = getRuntimeArch()
  const releaseName = getZigReleaseLibraryName()
  const debugName = getZigDebugLibraryName()

  const candidates: string[] = []
  if (platform && arch) {
    candidates.push(join(zigStageLibDir, platform, arch, releaseName))
    candidates.push(join(zigStageLibDir, platform, arch, debugName))
  }
  candidates.push(join(zigStageLibDir, releaseName))
  candidates.push(join(zigStageLibDir, debugName))

  for (const candidate of candidates) {
    attempted.push(candidate)
    if (existsSync(candidate)) {
      return { path: candidate, attempted }
    }
  }

  return { path: null, attempted }
}

function logMissingZigBridge(paths: string[], message: string): void {
  if (paths.length === 0) {
    return
  }
  const uniquePaths = [...new Set(paths)]
  const details = uniquePaths.map((candidate) => `  • ${candidate}`).join('\n')
  console.warn(`${message}\nSearched the following locations:\n${details}`)
}

function getRuntimePlatform(): 'darwin' | 'linux' | null {
  if (process.platform === 'darwin') {
    return 'darwin'
  }
  if (process.platform === 'linux') {
    return 'linux'
  }
  return null
}

function getRuntimeArch(): 'arm64' | 'x64' | null {
  if (process.arch === 'arm64') {
    return 'arm64'
  }
  if (process.arch === 'x64') {
    return 'x64'
  }
  return null
}

function getZigReleaseLibraryName(): string {
  if (process.platform === 'win32') {
    return 'temporal_bun_bridge_zig.dll'
  }
  if (process.platform === 'darwin') {
    return 'libtemporal_bun_bridge_zig.dylib'
  }
  return 'libtemporal_bun_bridge_zig.so'
}

function getZigDebugLibraryName(): string {
  if (process.platform === 'win32') {
    return 'temporal_bun_bridge_zig_debug.dll'
  }
  if (process.platform === 'darwin') {
    return 'libtemporal_bun_bridge_zig_debug.dylib'
  }
  return 'libtemporal_bun_bridge_zig_debug.so'
}

function resolveRustBridgeLibraryPath(): string {
  const baseName = getRustLibraryName()

  const releasePath = join(rustBridgeTargetDir, 'release', baseName)
  if (existsSync(releasePath)) {
    return releasePath
  }

  const debugPath = join(rustBridgeTargetDir, 'debug', baseName)
  if (existsSync(debugPath)) {
    return debugPath
  }

  const depsDir = join(rustBridgeTargetDir, 'debug', 'deps')
  if (existsSync(depsDir)) {
    const prefix = baseName.replace(/\.[^./]+$/, '')
    const candidate = readdirSync(depsDir)
      .filter((file) => file.startsWith(prefix))
      .map((file) => join(depsDir, file))
      .find((file) => existsSync(file))
    if (candidate) {
      return candidate
    }
  }

  throw new Error(
    `Temporal Bun bridge library not found. Expected at ${releasePath} or ${debugPath}. Did you build the native bridge?`,
  )
}

function getRustLibraryName(): string {
  if (process.platform === 'win32') {
    return 'temporal_bun_bridge.dll'
  }
  if (process.platform === 'darwin') {
    return 'libtemporal_bun_bridge.dylib'
  }
  return 'libtemporal_bun_bridge.so'
}

function readByteArray(pointer: number): Uint8Array {
  const header = new BigUint64Array(toArrayBuffer(pointer, 0, 24))
  const dataPtr = Number(header[0])
  const len = Number(header[1])
  const view = new Uint8Array(toArrayBuffer(dataPtr, 0, len))
  // Copy into JS-owned memory before the native buffer is released.
  const copy = new Uint8Array(view)
  temporal_bun_byte_array_free(pointer)
  return copy
}

async function waitForClientHandle(handle: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const poll = (): void => {
      const status = Number(temporal_bun_pending_client_poll(handle))
      if (status === 0) {
        setTimeout(poll, 0)
        return
      }

      if (status === 1) {
        try {
          const pointer = Number(temporal_bun_pending_client_consume(handle))
          if (!pointer) {
            throw new Error(readLastError())
          }
          resolve(pointer)
        } catch (error) {
          reject(error)
        }
        return
      }

      reject(new Error(readLastError()))
    }

    setTimeout(poll, 0)
  })
}

async function waitForByteArray(handle: number): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const poll = (): void => {
      const status = Number(temporal_bun_pending_byte_array_poll(handle))
      if (status === 0) {
        setTimeout(poll, 0)
        return
      }

      if (status === 1) {
        try {
          const arrayPtr = Number(temporal_bun_pending_byte_array_consume(handle))
          if (!arrayPtr) {
            throw new Error(readLastError())
          }
          resolve(readByteArray(arrayPtr))
        } catch (error) {
          reject(error)
        }
        return
      }

      // status === -1 or unexpected
      reject(new Error(readLastError()))
    }

    setTimeout(poll, 0)
  })
}

function readLastErrorText(): string {
  const lenBuffer = new BigUint64Array(1)
  const errPtr = Number(temporal_bun_error_message(ptr(lenBuffer)))
  const len = Number(lenBuffer[0])
  if (!errPtr || len === 0) {
    return 'Unknown native error'
  }
  try {
    const buffer = Buffer.from(toArrayBuffer(errPtr, 0, len))
    return buffer.toString('utf8')
  } finally {
    temporal_bun_error_free(errPtr, len)
  }
}

function readLastError(): string {
  return readLastErrorText()
}

function readLastErrorPayload(): NativeBridgeErrorInit {
  const raw = readLastErrorText()
  if (!raw) {
    return {
      code: UNKNOWN_NATIVE_ERROR_CODE,
      message: 'Unknown native error',
      raw,
    }
  }

  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof parsed.message === 'string') {
      return {
        code: typeof parsed.code === 'number' ? parsed.code : UNKNOWN_NATIVE_ERROR_CODE,
        message: parsed.message,
        details: parsed.details,
        raw,
      }
    }
  } catch {
    // fall through to default handling when the payload is not valid JSON
  }

  if (raw.startsWith('temporal-bun-bridge-zig:')) {
    const message = raw.replace(/^temporal-bun-bridge-zig:\s*/, '')
    const code = mapZigErrorCode(message)
    return {
      code,
      message,
      details: { source: 'zig', raw },
      raw: JSON.stringify({ code, message }),
    }
  }

  return {
    code: UNKNOWN_NATIVE_ERROR_CODE,
    message: raw,
    raw,
  }
}

function mapZigErrorCode(message: string): number {
  if (/received null runtime handle/i.test(message)) {
    return 3
  }
  if (/is not implemented yet/i.test(message)) {
    return 12
  }
  return UNKNOWN_NATIVE_ERROR_CODE
}

function buildNativeBridgeError(): NativeBridgeError {
  return new NativeBridgeError(readLastErrorPayload())
}

function buildNotImplementedError(feature: string, docPath: string): Error {
  return new Error(
    `${feature} is not implemented yet. See packages/temporal-bun-sdk/${docPath} for the implementation plan.`,
  )
}

function notImplemented(feature: string, docPath: string): never {
  throw buildNotImplementedError(feature, docPath)
}
