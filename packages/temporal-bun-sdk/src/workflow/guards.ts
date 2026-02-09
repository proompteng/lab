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
const ORIGINAL_BUN_SPAWN_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.spawn')
const ORIGINAL_BUN_NANOSECONDS_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Bun.nanoseconds')

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

export const installWorkflowRuntimeGuards = (options: { mode: WorkflowGuardsMode }) => {
  setMode(options.mode)

  const state = getGlobalState()
  if (state.installed) {
    return
  }

  const globalRef = globalThis as unknown as Record<symbol, unknown>

  // TODO(TBS-NDG-001): Date constructor deterministic wrapper.
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

  // TODO(TBS-NDG-001): Date.now deterministic wrapper.
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

  // TODO(TBS-NDG-001): Math.random deterministic wrapper.
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
      return originalRandom()
    }
    return ctx.guard.nextRandom(originalRandom)
  }

  // TODO(TBS-NDG-001): crypto.randomUUID deterministic wrapper.
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

  // TODO(TBS-NDG-001): crypto.getRandomValues deterministic wrapper.
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

  // TODO(TBS-NDG-001): fetch side-effect guard.
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

  // TODO(TBS-NDG-001): setTimeout guard.
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

  // TODO(TBS-NDG-001): setInterval guard.
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

  // TODO(TBS-NDG-001): performance.now guard.
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

  // TODO(TBS-NDG-001): WebSocket guard.
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  if (typeof originalWebSocket === 'function') {
    globalRef[ORIGINAL_WEBSOCKET_SYMBOL] = originalWebSocket
    // biome-ignore lint/complexity/useArrowFunction: must remain constructable (usable with `new`)
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = function (...args: unknown[]) {
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
  }

  // TODO(TBS-NDG-001): Bun.spawn guard.
  const maybeBun = (globalThis as unknown as { Bun?: unknown }).Bun as
    | { spawn?: (...args: unknown[]) => unknown; nanoseconds?: () => number }
    | undefined
  if (maybeBun?.spawn && typeof maybeBun.spawn === 'function') {
    globalRef[ORIGINAL_BUN_SPAWN_SYMBOL] = maybeBun.spawn.bind(maybeBun)
    maybeBun.spawn = (...args: unknown[]) => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'Bun.spawn',
          message: 'Bun.spawn() is not allowed in workflow code',
          remediation: 'Move subprocess execution into an activity and call it via ctx.activities.schedule(...).',
        })
        return (globalRef[ORIGINAL_BUN_SPAWN_SYMBOL] as (...args: unknown[]) => unknown)(...args)
      }
      handleViolation({
        api: 'Bun.spawn',
        message: 'Bun.spawn() is not allowed in workflow code',
        remediation: 'Move subprocess execution into an activity and call it via ctx.activities.schedule(...).',
      })
      return (globalRef[ORIGINAL_BUN_SPAWN_SYMBOL] as (...args: unknown[]) => unknown)(...args)
    }
  }

  // TODO(TBS-NDG-001): Bun.nanoseconds guard.
  if (maybeBun?.nanoseconds && typeof maybeBun.nanoseconds === 'function') {
    globalRef[ORIGINAL_BUN_NANOSECONDS_SYMBOL] = maybeBun.nanoseconds.bind(maybeBun)
    maybeBun.nanoseconds = () => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
        handleViolation({
          api: 'Bun.nanoseconds',
          message: 'Bun.nanoseconds() is not allowed in workflow code',
          remediation: 'Use workflow time via ctx.determinism.now(); avoid high-resolution timers in workflows.',
        })
        return (globalRef[ORIGINAL_BUN_NANOSECONDS_SYMBOL] as () => number)()
      }
      handleViolation({
        api: 'Bun.nanoseconds',
        message: 'Bun.nanoseconds() is not allowed in workflow code',
        remediation: 'Use workflow time via ctx.determinism.now(); avoid high-resolution timers in workflows.',
      })
      return (globalRef[ORIGINAL_BUN_NANOSECONDS_SYMBOL] as () => number)()
    }
  }

  state.installed = true
}
