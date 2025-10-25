import { type Runtime as NativeRuntime, native } from '../internal/core-bridge/native'

export interface RuntimeOptions {
  readonly options?: Record<string, unknown>
}

export class Runtime {
  #native: NativeRuntime | undefined

  static create(options: RuntimeOptions = {}): Runtime {
    return new Runtime(options)
  }

  private constructor(options: RuntimeOptions = {}) {
    this.#native = native.createRuntime(options.options ?? {})
    runtimeFinalizer.register(this, this.#native, this)
  }

  get nativeHandle(): NativeRuntime {
    if (!this.#native) {
      throw new Error('Runtime has already been shut down')
    }
    return this.#native
  }

  configureTelemetry(options: Record<string, unknown> = {}): never {
    // TODO(codex): Wire telemetry exporters through the native bridge once
    // `temporal_bun_runtime_update_telemetry` exists (see packages/temporal-bun-sdk/docs/ffi-surface.md).
    return native.configureTelemetry(this.nativeHandle, options)
  }

  installLogger(callback: (...args: unknown[]) => void): never {
    // TODO(codex): Forward Temporal Core logs into Bun via the native bridge per docs/ffi-surface.md.
    return native.installLogger(this.nativeHandle, callback)
  }

  async shutdown(): Promise<void> {
    if (!this.#native) return
    native.runtimeShutdown(this.#native)
    runtimeFinalizer.unregister(this)
    this.#native = undefined
  }
}

const finalizeRuntime = (runtime: NativeRuntime): void => {
  try {
    native.runtimeShutdown(runtime)
  } catch {
    // Swallow errors during GC finalization to avoid process crashes.
  }
}

const runtimeFinalizer = new FinalizationRegistry<NativeRuntime>(finalizeRuntime)

export const createRuntime = (options: RuntimeOptions = {}): Runtime => Runtime.create(options)

export const __TEST__ = {
  finalizeRuntime,
}
