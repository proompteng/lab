import { Effect } from 'effect'

import { WorkflowNondeterminismError, WorkflowQueryViolationError } from './errors'
import { currentWorkflowLogContext, runOutsideWorkflowLogContext } from './log'
import { currentWorkflowModuleLoadContext } from './module-load'

export type WorkflowGuardsMode = 'strict' | 'warn' | 'off'

type GlobalGuardState = {
  installed: boolean
  mode: WorkflowGuardsMode
}

const MODE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.workflowGuards.mode')
const STATE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.workflowGuards.state')

// These symbols are intentionally stable and are used by workflow context helpers
// without importing this module (avoids ESM import cycles).
const ORIGINAL_DATE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Date')
const ORIGINAL_DATE_NOW_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Date.now')
const ORIGINAL_MATH_RANDOM_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Math.random')

const ORIGINAL_CRYPTO_RANDOM_UUID_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.crypto.randomUUID')
const ORIGINAL_CRYPTO_GET_RANDOM_VALUES_SYMBOL = Symbol.for(
  '@proompteng/temporal-bun-sdk.original.crypto.getRandomValues',
)

const ORIGINAL_FETCH_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.fetch')
const ORIGINAL_SET_TIMEOUT_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.setTimeout')
const ORIGINAL_SET_INTERVAL_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.setInterval')
const ORIGINAL_PERFORMANCE_NOW_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.performance.now')
const ORIGINAL_WEBSOCKET_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.WebSocket')
const ORIGINAL_PROCESS_ENV_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.process.env')
const ORIGINAL_BUN_ENV_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.env')
const ORIGINAL_BUN_SPAWN_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.spawn')
const ORIGINAL_BUN_NANOSECONDS_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.nanoseconds')
const ORIGINAL_BUN_SLEEP_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.sleep')
const ORIGINAL_BUN_FILE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.file')
const ORIGINAL_BUN_WRITE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.write')
const ORIGINAL_BUN_CONNECT_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.connect')
const ORIGINAL_BUN_SERVE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.serve')

type ViolationDetails = {
  readonly api: string
  readonly message: string
  readonly remediation: string
}

const getGlobalState = (): GlobalGuardState => {
  const globalRef = globalThis as unknown as Record<symbol, unknown>
  const state = globalRef[STATE_SYMBOL] as GlobalGuardState | undefined
  if (state) {
    return state
  }
  const initial: GlobalGuardState = {
    installed: false,
    mode: 'warn',
  }
  globalRef[STATE_SYMBOL] = initial
  globalRef[MODE_SYMBOL] = initial.mode
  return initial
}

const setMode = (mode: WorkflowGuardsMode) => {
  const state = getGlobalState()
  state.mode = mode
  ;(globalThis as unknown as Record<symbol, unknown>)[MODE_SYMBOL] = mode
}

const currentMode = (): WorkflowGuardsMode => {
  const stored = (globalThis as unknown as Record<symbol, unknown>)[MODE_SYMBOL]
  if (stored === 'strict' || stored === 'warn' || stored === 'off') {
    return stored
  }
  return getGlobalState().mode
}

const warnViolationFallback = (details: ViolationDetails, context: { source: string }) => {
  console.warn('[temporal-bun-sdk] workflow runtime guard violation', {
    source: context.source,
    guardApi: details.api,
    guardMessage: details.message,
    guardRemediation: details.remediation,
    guardMode: currentMode(),
  })
}

const warnViolation = (details: ViolationDetails) => {
  const ctx = currentWorkflowLogContext()
  if (!ctx) {
    return
  }

  runOutsideWorkflowLogContext(() => {
    void Effect.runPromise(
      ctx.logger.log('warn', 'workflow runtime guard violation', {
        sdkComponent: 'workflow',
        namespace: ctx.info.namespace,
        taskQueue: ctx.info.taskQueue,
        workflowId: ctx.info.workflowId,
        runId: ctx.info.runId,
        workflowType: ctx.info.workflowType,
        guardApi: details.api,
        guardMessage: details.message,
        guardRemediation: details.remediation,
        guardMode: currentMode(),
        guardQueryMode: ctx.guard.isQueryMode(),
      }),
    )
  })
}

const throwViolation = (details: ViolationDetails): never => {
  const ctx = currentWorkflowLogContext()
  const queryMode = ctx?.guard.isQueryMode() ?? false
  if (queryMode) {
    throw new WorkflowQueryViolationError(`${details.message} (${details.api})`)
  }
  throw new WorkflowNondeterminismError(details.message, {
    received: { api: details.api },
    hint: details.remediation,
  })
}

const handleViolationOutsideWorkflowContext = (
  details: ViolationDetails,
  context: { source: string; mode: WorkflowGuardsMode },
): void => {
  // In module-load contexts, we don't have workflow metadata or a workflow logger. Use console and
  // treat strict mode as fatal so the worker fails fast.
  if (context.mode === 'off') {
    return
  }
  if (context.mode === 'warn') {
    warnViolationFallback(details, { source: context.source })
    return
  }
  throwViolation(details)
}

const handleViolation = (details: ViolationDetails): void => {
  const ctx = currentWorkflowLogContext()
  if (!ctx) {
    const moduleLoad = currentWorkflowModuleLoadContext()
    if (moduleLoad) {
      handleViolationOutsideWorkflowContext(details, { source: 'workflow-module-load', mode: moduleLoad.mode })
    }
    return
  }

  // Queries must be strictly read-only regardless of guard mode.
  if (ctx.guard.isQueryMode()) {
    throwViolation(details)
  }

  const mode = currentMode()
  if (mode === 'off') {
    return
  }
  if (mode === 'warn') {
    warnViolation(details)
    return
  }
  throwViolation(details)
}

const guardEnvironmentViolation = (api: string, action: 'enumeration' | 'inspection' | 'mutation' | 'read') => {
  const messages = {
    enumeration: `${api} enumeration is not allowed in workflow code`,
    inspection: `${api} inspection is not allowed in workflow code`,
    mutation: `${api} mutation is not allowed in workflow code`,
    read: `${api} is not allowed in workflow code`,
  } as const
  handleViolation({
    api,
    message: messages[action],
    remediation:
      action === 'mutation'
        ? 'Move environment mutation into worker bootstrap code or an activity.'
        : 'Pass environment-derived configuration into the workflow input or activity input before the workflow starts.',
  })
}

const guardedEnvironment = <T extends object>(target: T, api: string): T =>
  new Proxy(target, {
    get(current, property, receiver) {
      if (typeof property === 'string') {
        guardEnvironmentViolation(api, 'read')
      }
      return Reflect.get(current, property, receiver)
    },
    set(current, property, value, receiver) {
      if (typeof property === 'string') {
        guardEnvironmentViolation(api, 'mutation')
      }
      return Reflect.set(current, property, value, receiver)
    },
    has(current, property) {
      if (typeof property === 'string') {
        guardEnvironmentViolation(api, 'inspection')
      }
      return Reflect.has(current, property)
    },
    ownKeys(current) {
      guardEnvironmentViolation(api, 'enumeration')
      return Reflect.ownKeys(current)
    },
  })

const guardEnvironmentObjectProperties = (target: Record<string, string | undefined>, api: string) => {
  const values = new Map<string, string | undefined>()
  for (const key of Object.keys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor?.configurable) {
      continue
    }
    values.set(key, descriptor.get ? (descriptor.get.call(target) as string | undefined) : descriptor.value)
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        guardEnvironmentViolation(api, 'read')
        return values.get(key)
      },
      set(value: string | undefined) {
        guardEnvironmentViolation(api, 'mutation')
        values.set(key, value)
      },
    })
  }

  const originalPrototype = Object.getPrototypeOf(target)
  if (!originalPrototype || Object.prototype.hasOwnProperty.call(originalPrototype, '__temporalBunSdkEnvGuard')) {
    return
  }

  Object.setPrototypeOf(
    target,
    new Proxy(Object.create(originalPrototype) as Record<PropertyKey, unknown>, {
      get(current, property, receiver) {
        if (typeof property === 'string') {
          guardEnvironmentViolation(api, 'read')
        }
        return Reflect.get(current, property, receiver)
      },
      set(current, property, value, receiver) {
        if (typeof property === 'string') {
          guardEnvironmentViolation(api, 'mutation')
        }
        return Reflect.set(current, property, value, receiver)
      },
      has(current, property) {
        if (typeof property === 'string') {
          guardEnvironmentViolation(api, 'inspection')
        }
        return Reflect.has(current, property)
      },
      getOwnPropertyDescriptor(current, property) {
        if (property === '__temporalBunSdkEnvGuard') {
          return {
            configurable: true,
            enumerable: false,
            value: true,
          }
        }
        return Reflect.getOwnPropertyDescriptor(current, property)
      },
    }),
  )
}

export const installWorkflowRuntimeGuards = (options: { mode: WorkflowGuardsMode }) => {
  setMode(options.mode)

  const state = getGlobalState()
  if (state.installed) {
    return
  }

  const globalRef = globalThis as unknown as Record<symbol, unknown>

  const OriginalDate = Date
  globalRef[ORIGINAL_DATE_SYMBOL] = OriginalDate
  const originalDateNow = OriginalDate.now.bind(OriginalDate)
  globalRef[ORIGINAL_DATE_NOW_SYMBOL] = originalDateNow

  const PatchedDate = function (this: unknown, ...args: unknown[]) {
    const ctx = currentWorkflowLogContext()
    const moduleLoad = currentWorkflowModuleLoadContext()

    const inWorkflow = Boolean(ctx)
    const inModuleLoad = Boolean(!ctx && moduleLoad)

    const isQueryMode = ctx?.guard.isQueryMode() ?? false

    const handleModuleInitTimeViolation = () => {
      if (!moduleLoad) {
        return
      }
      handleViolationOutsideWorkflowContext(
        {
          api: 'Date',
          message: 'Date() / new Date() is not allowed during workflow module initialization',
          remediation:
            'Move time-dependent initialization into the workflow handler, or use determinism.sideEffect(...) to record a value.',
        },
        { source: 'workflow-module-load', mode: moduleLoad.mode },
      )
    }

    const nextTime = (): number => {
      if (inModuleLoad) {
        handleModuleInitTimeViolation()
        return originalDateNow()
      }
      if (inWorkflow && !isQueryMode) {
        return ctx?.guard.nextTime(originalDateNow) ?? originalDateNow()
      }
      return originalDateNow()
    }

    const asConstructor = Boolean(new.target)
    if (args.length === 0) {
      const time = nextTime()
      if (asConstructor) {
        return new OriginalDate(time)
      }
      return new OriginalDate(time).toString()
    }

    // Date(...) ignores args when called as a function; preserve that behavior.
    if (!asConstructor) {
      return new OriginalDate(nextTime()).toString()
    }

    // @ts-expect-error - Date constructor is variadic.
    return new OriginalDate(...args)
  } as unknown as DateConstructor

  ;(PatchedDate as unknown as { prototype: unknown }).prototype = OriginalDate.prototype
  Object.setPrototypeOf(PatchedDate, OriginalDate)
  globalThis.Date = PatchedDate

  Date.now = () => {
    const ctx = currentWorkflowLogContext()
    if (!ctx) {
      const moduleLoad = currentWorkflowModuleLoadContext()
      if (moduleLoad) {
        handleViolationOutsideWorkflowContext(
          {
            api: 'Date.now',
            message: 'Date.now() is not allowed during workflow module initialization',
            remediation:
              'Move time-dependent initialization into the workflow handler, or use determinism.sideEffect(...) to record a value.',
          },
          { source: 'workflow-module-load', mode: moduleLoad.mode },
        )
      }
      return originalDateNow()
    }
    if (ctx.guard.isQueryMode()) {
      return originalDateNow()
    }
    return ctx.guard.nextTime(originalDateNow)
  }

  const originalRandom = Math.random.bind(Math)
  globalRef[ORIGINAL_MATH_RANDOM_SYMBOL] = originalRandom
  Math.random = () => {
    const ctx = currentWorkflowLogContext()
    if (!ctx) {
      const moduleLoad = currentWorkflowModuleLoadContext()
      if (moduleLoad) {
        handleViolationOutsideWorkflowContext(
          {
            api: 'Math.random',
            message: 'Math.random() is not allowed during workflow module initialization',
            remediation:
              'Move randomness into the workflow handler, or use determinism.sideEffect(...) to record a value.',
          },
          { source: 'workflow-module-load', mode: moduleLoad.mode },
        )
      }
      return originalRandom()
    }
    if (ctx.guard.isQueryMode()) {
      handleViolation({
        api: 'Math.random',
        message: 'Math.random() cannot read live randomness during workflow query evaluation',
        remediation: 'Queries must be read-only; read workflow state recorded during normal workflow tasks.',
      })
      return originalRandom()
    }
    return ctx.guard.nextRandom(originalRandom)
  }

  const cryptoRef = (globalThis as unknown as { crypto?: unknown }).crypto as
    | { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView>(array: T) => T }
    | undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    const original = cryptoRef.randomUUID.bind(cryptoRef)
    globalRef[ORIGINAL_CRYPTO_RANDOM_UUID_SYMBOL] = original

    cryptoRef.randomUUID = () => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'crypto.randomUUID',
          message: 'crypto.randomUUID() is not allowed in workflow code',
          remediation:
            'Move randomness into the workflow handler, or use determinism.sideEffect(...) to record a value.',
        })
        return original()
      }
      if (ctx.guard.isQueryMode()) {
        handleViolation({
          api: 'crypto.randomUUID',
          message: 'crypto.randomUUID() cannot read live randomness during workflow query evaluation',
          remediation: 'Queries must be read-only; read workflow state recorded during normal workflow tasks.',
        })
        return original()
      }

      const bytes = new Uint8Array(16)
      for (let offset = 0; offset < bytes.length; offset += 4) {
        const word = Math.trunc(ctx.guard.nextRandom(originalRandom) * 0x1_0000_0000) >>> 0
        bytes[offset] = word & 0xff
        bytes[offset + 1] = (word >>> 8) & 0xff
        bytes[offset + 2] = (word >>> 16) & 0xff
        bytes[offset + 3] = (word >>> 24) & 0xff
      }

      // UUID v4 variant bits.
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80

      const hex = (value: number) => value.toString(16).padStart(2, '0')
      return (
        `${hex(bytes[0])}${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}-` +
        `${hex(bytes[4])}${hex(bytes[5])}-` +
        `${hex(bytes[6])}${hex(bytes[7])}-` +
        `${hex(bytes[8])}${hex(bytes[9])}-` +
        `${hex(bytes[10])}${hex(bytes[11])}${hex(bytes[12])}${hex(bytes[13])}${hex(bytes[14])}${hex(bytes[15])}`
      )
    }
  }

  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    const original = cryptoRef.getRandomValues.bind(cryptoRef)
    globalRef[ORIGINAL_CRYPTO_GET_RANDOM_VALUES_SYMBOL] = original

    cryptoRef.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'crypto.getRandomValues',
          message: 'crypto.getRandomValues() is not allowed in workflow code',
          remediation:
            'Move randomness into the workflow handler, or use determinism.sideEffect(...) to record a value.',
        })
        return original(array)
      }
      if (ctx.guard.isQueryMode()) {
        handleViolation({
          api: 'crypto.getRandomValues',
          message: 'crypto.getRandomValues() cannot read live randomness during workflow query evaluation',
          remediation: 'Queries must be read-only; read workflow state recorded during normal workflow tasks.',
        })
        return original(array)
      }

      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      const maxBytes = 4096
      if (view.byteLength > maxBytes) {
        handleViolation({
          api: 'crypto.getRandomValues',
          message: `crypto.getRandomValues() requested too many bytes (${view.byteLength})`,
          remediation: `Limit getRandomValues() to <= ${maxBytes} bytes per call, or use determinism.sideEffect(...) to record a value.`,
        })
        return original(array)
      }

      for (let offset = 0; offset < view.length; offset += 4) {
        const word = Math.trunc(ctx.guard.nextRandom(originalRandom) * 0x1_0000_0000) >>> 0
        view[offset] = word & 0xff
        if (offset + 1 < view.length) view[offset + 1] = (word >>> 8) & 0xff
        if (offset + 2 < view.length) view[offset + 2] = (word >>> 16) & 0xff
        if (offset + 3 < view.length) view[offset + 3] = (word >>> 24) & 0xff
      }

      return array
    }
  }

  const originalFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined
  if (originalFetch) {
    globalRef[ORIGINAL_FETCH_SYMBOL] = originalFetch
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'fetch',
          message: 'fetch() is not allowed in workflow code',
          remediation: 'Move network I/O into an activity and call it via ctx.activities.schedule(...).',
        })
        return originalFetch(...args)
      }
      handleViolation({
        api: 'fetch',
        message: 'fetch() is not allowed in workflow code',
        remediation: 'Move network I/O into an activity and call it via ctx.activities.schedule(...).',
      })
      return originalFetch(...args)
    }) as typeof fetch
  }

  const originalSetTimeout = typeof setTimeout === 'function' ? setTimeout.bind(globalThis) : undefined
  if (originalSetTimeout) {
    globalRef[ORIGINAL_SET_TIMEOUT_SYMBOL] = originalSetTimeout
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'setTimeout',
          message: 'setTimeout() is not allowed in workflow code',
          remediation: 'Use workflow timers via ctx.timers.start({ timeoutMs }) instead.',
        })
        return originalSetTimeout(...args)
      }
      handleViolation({
        api: 'setTimeout',
        message: 'setTimeout() is not allowed in workflow code',
        remediation: 'Use workflow timers via ctx.timers.start({ timeoutMs }) instead.',
      })
      return originalSetTimeout(...args)
    }) as typeof setTimeout
  }

  const originalSetInterval = typeof setInterval === 'function' ? setInterval.bind(globalThis) : undefined
  if (originalSetInterval) {
    globalRef[ORIGINAL_SET_INTERVAL_SYMBOL] = originalSetInterval
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'setInterval',
          message: 'setInterval() is not allowed in workflow code',
          remediation: 'Use workflow timers via ctx.timers.start({ timeoutMs }) instead.',
        })
        return originalSetInterval(...args)
      }
      handleViolation({
        api: 'setInterval',
        message: 'setInterval() is not allowed in workflow code',
        remediation: 'Use workflow timers via ctx.timers.start({ timeoutMs }) instead.',
      })
      return originalSetInterval(...args)
    }) as typeof setInterval
  }

  const originalPerformanceNow =
    typeof globalThis.performance?.now === 'function'
      ? globalThis.performance.now.bind(globalThis.performance)
      : undefined
  if (originalPerformanceNow && globalThis.performance) {
    globalRef[ORIGINAL_PERFORMANCE_NOW_SYMBOL] = originalPerformanceNow
    globalThis.performance.now = () => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'performance.now',
          message: 'performance.now() is not allowed in workflow code',
          remediation: 'Use workflow time via ctx.determinism.now() and workflow timers for delays.',
        })
        return originalPerformanceNow()
      }
      handleViolation({
        api: 'performance.now',
        message: 'performance.now() is not allowed in workflow code',
        remediation: 'Use workflow time via ctx.determinism.now() and workflow timers for delays.',
      })
      return originalPerformanceNow()
    }
  }

  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  if (typeof originalWebSocket === 'function') {
    globalRef[ORIGINAL_WEBSOCKET_SYMBOL] = originalWebSocket
    // biome-ignore lint/complexity/useArrowFunction: must remain constructable (usable with `new`)
    const PatchedWebSocket = function (...args: unknown[]) {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'WebSocket',
          message: 'WebSocket is not allowed in workflow code',
          remediation: 'Move socket I/O into an activity or an external service and communicate via signals.',
        })
        return new (originalWebSocket as unknown as new (...args: unknown[]) => unknown)(...args)
      }
      handleViolation({
        api: 'WebSocket',
        message: 'WebSocket is not allowed in workflow code',
        remediation: 'Move socket I/O into an activity or an external service and communicate via signals.',
      })
      return new (originalWebSocket as unknown as new (...args: unknown[]) => unknown)(...args)
    }
    ;(PatchedWebSocket as unknown as { prototype: unknown }).prototype = (
      originalWebSocket as unknown as { prototype: unknown }
    ).prototype
    Object.setPrototypeOf(PatchedWebSocket, originalWebSocket)
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = PatchedWebSocket
  }

  const processRef = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
  const maybeBun = (globalThis as unknown as { Bun?: unknown }).Bun as
    | (Record<string, unknown> & { env?: Record<string, string | undefined> })
    | undefined

  const originalProcessEnv = processRef?.env
  const originalBunEnv = maybeBun?.env

  if (originalProcessEnv && typeof originalProcessEnv === 'object') {
    globalRef[ORIGINAL_PROCESS_ENV_SYMBOL] = originalProcessEnv
    processRef.env = guardedEnvironment(originalProcessEnv, 'process.env') as typeof processRef.env
  }

  if (originalBunEnv && typeof originalBunEnv === 'object') {
    globalRef[ORIGINAL_BUN_ENV_SYMBOL] = originalBunEnv
    const bunEnvDescriptor = maybeBun ? Object.getOwnPropertyDescriptor(maybeBun, 'env') : undefined
    if (bunEnvDescriptor?.writable) {
      maybeBun.env = guardedEnvironment(originalBunEnv, 'Bun.env') as typeof maybeBun.env
    } else {
      guardEnvironmentObjectProperties(originalBunEnv, 'Bun.env')
    }
  }

  const guardBunFunction = (key: string, originalSymbol: symbol, remediation: string) => {
    if (!maybeBun) {
      return
    }
    const original = maybeBun[key]
    if (typeof original !== 'function') {
      return
    }
    globalRef[originalSymbol] = original.bind(maybeBun)
    maybeBun[key] = (...args: unknown[]) => {
      const api = `Bun.${key}`
      handleViolation({
        api,
        message: `${api}() is not allowed in workflow code`,
        remediation,
      })
      return (globalRef[originalSymbol] as (...args: unknown[]) => unknown)(...args)
    }
  }

  guardBunFunction(
    'spawn',
    ORIGINAL_BUN_SPAWN_SYMBOL,
    'Move subprocess execution into an activity and call it via ctx.activities.schedule(...).',
  )
  guardBunFunction(
    'nanoseconds',
    ORIGINAL_BUN_NANOSECONDS_SYMBOL,
    'Use workflow time via ctx.determinism.now(); avoid high-resolution timers in workflows.',
  )
  guardBunFunction(
    'sleep',
    ORIGINAL_BUN_SLEEP_SYMBOL,
    'Use workflow timers via ctx.timers.start({ timeoutMs }) instead.',
  )
  guardBunFunction('file', ORIGINAL_BUN_FILE_SYMBOL, 'Move filesystem I/O into an activity.')
  guardBunFunction('write', ORIGINAL_BUN_WRITE_SYMBOL, 'Move filesystem I/O into an activity.')
  guardBunFunction('connect', ORIGINAL_BUN_CONNECT_SYMBOL, 'Move socket I/O into an activity or external service.')
  guardBunFunction(
    'serve',
    ORIGINAL_BUN_SERVE_SYMBOL,
    'Move server I/O out of workflow code and into worker bootstrap code.',
  )

  state.installed = true
}
