import Module from 'module'
import { AsyncLocalStorage as NodeAsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { URL, URLSearchParams } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'

type TemporalGlobals = {
  importWorkflows: () => unknown
  importInterceptors: () => unknown[]
}

const stubModuleCacheKey = (() => {
  // Use a pseudo unique cache key to avoid collisions with real files.
  // Module cache expects an absolute path-like identifier.
  const base = process.cwd()
  return `${base}/.temporal-bun-sdk/stubs/__temporal_stubs.js`
})()

class SimpleAsyncLocalStorage<T> {
  #store: T | undefined

  run<R>(value: T, fn: () => R): R {
    const previous = this.#store
    this.#store = value
    try {
      return fn()
    } finally {
      this.#store = previous
    }
  }

  getStore(): T | undefined {
    return this.#store
  }

  disable(): void {
    this.#store = undefined
  }
}

let bootstrapCompleted = false

const temporalModuleRequests = new Set(['__temporal_custom_payload_converter', '__temporal_custom_failure_converter'])

/**
 * Ensure the ambient JS runtime exposes the globals that Temporal's workflow runtime
 * expects when running inside an isolated VM. Bun does not preload these values, so we
 * mirror the Node worker setup by injecting them once.
 */
export const ensureWorkflowRuntimeBootstrap = (): void => {
  if (bootstrapCompleted) {
    return
  }
  bootstrapCompleted = true

  const globalAny = globalThis as typeof globalThis & {
    AsyncLocalStorage?: typeof AsyncLocalStorage
    URL?: typeof URL
    URLSearchParams?: typeof URLSearchParams
    assert?: typeof assert
    TextEncoder?: typeof TextEncoder
    TextDecoder?: typeof TextDecoder
  } & {
    __TEMPORAL__?: TemporalGlobals
  }

  globalAny.AsyncLocalStorage = NodeAsyncLocalStorage ?? SimpleAsyncLocalStorage
  if (!globalAny.URL) {
    globalAny.URL = URL
  }
  if (!globalAny.URLSearchParams) {
    globalAny.URLSearchParams = URLSearchParams
  }
  if (!globalAny.assert) {
    globalAny.assert = assert
  }
  if (!globalAny.TextEncoder) {
    globalAny.TextEncoder = TextEncoder
  }
  if (!globalAny.TextDecoder) {
    globalAny.TextDecoder = TextDecoder
  }

  // Install a module cache entry so CJS require lookups for the webpack aliases resolve.
  const requireBootstrap = createRequire(import.meta.url)

  if (!requireBootstrap.cache[stubModuleCacheKey]) {
    requireBootstrap.cache[stubModuleCacheKey] = {
      id: stubModuleCacheKey,
      filename: stubModuleCacheKey,
      loaded: true,
      exports: {
        payloadConverter: undefined,
        failureConverter: undefined,
      },
      children: [],
      paths: Module._nodeModulePaths(process.cwd()),
    }
  }

  const originalResolveFilename = Module._resolveFilename
  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (temporalModuleRequests.has(request)) {
      return stubModuleCacheKey
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
  }
}

export const withTemporalGlobals = async <T>(globals: TemporalGlobals, execute: () => Promise<T> | T): Promise<T> => {
  const globalAny = globalThis as typeof globalThis & { __TEMPORAL__?: TemporalGlobals }
  const previous = globalAny.__TEMPORAL__
  globalAny.__TEMPORAL__ = globals
  try {
    return await execute()
  } finally {
    if (previous === undefined) {
      delete globalAny.__TEMPORAL__
    } else {
      globalAny.__TEMPORAL__ = previous
    }
  }
}
