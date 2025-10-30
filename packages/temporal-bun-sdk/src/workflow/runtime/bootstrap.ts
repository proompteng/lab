import assert from 'node:assert'
import { AsyncLocalStorage as NodeAsyncLocalStorage } from 'node:async_hooks'
import Module, { createRequire } from 'node:module'
import { URL, URLSearchParams } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import type { FailureConverter, PayloadConverter } from '@temporalio/common'

import type { DataConverter } from '../../common/payloads'

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

type ConverterModuleExports = {
  payloadConverter?: PayloadConverter
  failureConverter?: FailureConverter
}

let converterExports: ConverterModuleExports | undefined

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
    AsyncLocalStorage?: typeof NodeAsyncLocalStorage | typeof SimpleAsyncLocalStorage
    URL?: typeof globalThis.URL
    URLSearchParams?: typeof globalThis.URLSearchParams
    assert?: typeof assert
    TextEncoder?: typeof TextEncoder
    TextDecoder?: typeof TextDecoder
    __TEMPORAL__?: TemporalGlobals
  }

  globalAny.AsyncLocalStorage =
    (NodeAsyncLocalStorage as typeof NodeAsyncLocalStorage | undefined) ?? SimpleAsyncLocalStorage
  if (!globalAny.URL) {
    globalAny.URL = URL as unknown as typeof globalThis.URL
  }
  if (!globalAny.URLSearchParams) {
    globalAny.URLSearchParams = URLSearchParams as unknown as typeof globalThis.URLSearchParams
  }
  if (!globalAny.assert) {
    globalAny.assert = assert
  }
  if (!globalAny.TextEncoder) {
    globalAny.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder
  }
  if (!globalAny.TextDecoder) {
    globalAny.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder
  }

  // Install a module cache entry so CJS require lookups for the webpack aliases resolve.
  const requireBootstrap = createRequire(import.meta.url)

  type ModuleInternals = typeof Module & {
    _resolveFilename?: (request: string, parent?: NodeJS.Module | null, isMain?: boolean, options?: unknown) => string
    _nodeModulePaths?: (from: string) => string[]
  }

  const moduleInternals = Module as ModuleInternals

  if (!requireBootstrap.cache[stubModuleCacheKey]) {
    const modulePaths = moduleInternals._nodeModulePaths?.(process.cwd()) ?? []
    const moduleCacheEntry = {
      id: stubModuleCacheKey,
      filename: stubModuleCacheKey,
      path: process.cwd(),
      loaded: true,
      exports: {
        payloadConverter: undefined,
        failureConverter: undefined,
      },
      parent: null,
      children: [] as NodeJS.Module[],
      paths: modulePaths,
      require: requireBootstrap,
    } as unknown as NodeJS.Module

    requireBootstrap.cache[stubModuleCacheKey] = moduleCacheEntry
    converterExports = moduleCacheEntry.exports as ConverterModuleExports
  } else {
    const existing = requireBootstrap.cache[stubModuleCacheKey]
    if (existing) {
      converterExports = existing.exports as ConverterModuleExports
    }
  }

  const originalResolveFilename = moduleInternals._resolveFilename
  if (originalResolveFilename) {
    const patchedResolveFilename: typeof originalResolveFilename = (request, parent, isMain, options) => {
      if (temporalModuleRequests.has(request)) {
        return stubModuleCacheKey
      }
      return Reflect.apply(originalResolveFilename, moduleInternals, [request, parent, isMain, options])
    }

    moduleInternals._resolveFilename = patchedResolveFilename
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

export const setWorkflowDataConverter = (converter: DataConverter | null | undefined): void => {
  if (!converterExports) {
    throw new Error('Temporal workflow runtime stub was not initialized')
  }

  converterExports.payloadConverter = converter?.payloadConverter ?? undefined
  converterExports.failureConverter = converter?.failureConverter ?? undefined
}
