import { Effect } from 'effect'

import { WorkflowNondeterminismError, WorkflowQueryViolationError } from './errors'
import { currentWorkflowLogContext, runOutsideWorkflowLogContext } from './log'

export type WorkflowGuardsMode = 'strict' | 'warn' | 'off'

type GlobalGuardState = {
  installed: boolean
  mode: WorkflowGuardsMode
}

const MODE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.workflowGuards.mode')
const STATE_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.workflowGuards.state')

// These symbols are intentionally stable and are used by workflow context helpers
// without importing this module (avoids ESM import cycles).
const ORIGINAL_DATE_NOW_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Date.now')
const ORIGINAL_MATH_RANDOM_SYMBOL = Symbol.for('@proompteng/temporal-bun-sdk.original.Math.random')

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

const handleViolation = (details: ViolationDetails): void => {
  const ctx = currentWorkflowLogContext()
  if (!ctx) {
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

  // TODO(TBS-NDG-001): Date.now deterministic wrapper.
  const originalDateNow = Date.now.bind(Date)
  globalRef[ORIGINAL_DATE_NOW_SYMBOL] = originalDateNow
  Date.now = () => {
    const ctx = currentWorkflowLogContext()
    if (!ctx) {
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
      return originalRandom()
    }
    if (ctx.guard.isQueryMode()) {
      return originalRandom()
    }
    return ctx.guard.nextRandom(originalRandom)
  }

  // TODO(TBS-NDG-001): fetch side-effect guard.
  const originalFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined
  if (originalFetch) {
    globalRef[ORIGINAL_FETCH_SYMBOL] = originalFetch
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      const ctx = currentWorkflowLogContext()
      if (!ctx) {
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
