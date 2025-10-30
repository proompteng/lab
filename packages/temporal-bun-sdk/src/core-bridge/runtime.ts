import { type Runtime as NativeRuntime, native, type TemporalCoreLogger } from '../internal/core-bridge/native'

export interface RuntimeOptions {
  readonly options?: Record<string, unknown>
}

export class Runtime {
  #native: NativeRuntime | undefined
  #loggerInstalled = false

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

  installLogger(callback: TemporalCoreLogger): void {
    if (this.#loggerInstalled) {
      throw new Error('A logger is already installed for this runtime')
    }

    native.installLogger(this.nativeHandle, callback, () => {
      this.#loggerInstalled = false
    })
    this.#loggerInstalled = true
  }

  removeLogger(): void {
    if (!this.#native || !this.#loggerInstalled) {
      return
    }
    native.removeLogger(this.#native)
    this.#loggerInstalled = false
  }

  async shutdown(): Promise<void> {
    if (!this.#native) return
    if (this.#loggerInstalled) {
      native.removeLogger(this.#native)
      this.#loggerInstalled = false
    }
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

export type { TemporalCoreLogEvent, TemporalCoreLogLevel } from '../internal/core-bridge/native'
