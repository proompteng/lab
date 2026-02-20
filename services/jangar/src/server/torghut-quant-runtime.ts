import { EventEmitter } from 'node:events'
import { recordTorghutQuantComputeDurationMs, recordTorghutQuantComputeError, recordTorghutQuantFrame } from './metrics'
import type { QuantAlert, QuantSnapshotFrame, QuantWindow } from './torghut-quant-contract'
import { computeTorghutQuantMetrics, listTorghutStrategyAccounts } from './torghut-quant-metrics'
import {
  appendQuantPipelineHealth,
  appendQuantSeriesMetrics,
  upsertQuantAlerts,
  upsertQuantLatestMetrics,
} from './torghut-quant-metrics-store'
import { listTorghutTradingStrategies } from './torghut-trading'
import { resolveTorghutDb } from './torghut-trading-db'

type QuantStreamSnapshotEvent = {
  type: 'quant.metrics.snapshot'
  frame: QuantSnapshotFrame
}

type QuantStreamDeltaEvent = {
  type: 'quant.metrics.delta'
  strategyId: string
  account: string
  window: QuantWindow
  changed: Array<{ metricName: string; valueNumeric: number | null; asOf: string; quality: string; status: string }>
  frameAsOf: string
}

type QuantStreamAlertEvent = {
  type: 'quant.alert.opened' | 'quant.alert.resolved'
  alert: QuantAlert
}

type QuantStreamErrorEvent = {
  type: 'error'
  message: string
}

type AlertEvaluationCandidate = {
  breachKey: string
  minConsecutive: number
  alert: QuantAlert
}

export type QuantStreamEvent =
  | QuantStreamSnapshotEvent
  | QuantStreamDeltaEvent
  | QuantStreamAlertEvent
  | QuantStreamErrorEvent

type RuntimeConfig = {
  enabled: boolean
  computeIntervalMs: number
  heavyComputeIntervalMs: number
  seriesSamplingMs: number
  streamHeartbeatMs: number
  maxStalenessSeconds: number
  windowsLight: QuantWindow[]
  windowsHeavy: QuantWindow[]
  alertsEnabled: boolean
  policy: {
    maxDrawdown1d: number
    minSharpe5d: number
    maxSlippageBps15m: number
    maxRejectRate15m: number
    maxPipelineLagSeconds: number
    maxTaFreshnessSeconds: number
  }
}

const globalState = globalThis as typeof globalThis & {
  __torghutQuantRuntime?: {
    started: boolean
    emitter: EventEmitter
    config: RuntimeConfig
    lastFrames: Map<FrameKey, QuantSnapshotFrame>
    lastSeriesAppendAtMs: Map<FrameKey, number>
    openAlertsByFrame: Map<FrameKey, Map<string, QuantAlert>>
    alertBreachStreakByFrame: Map<FrameKey, Map<string, number>>
  }
}

const resolveBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const parseNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

const resolveWindows = (raw: string | undefined, fallback: QuantWindow[]) => {
  if (!raw) return fallback
  const normalized = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as QuantWindow[]
  return normalized.length > 0 ? normalized : fallback
}

const loadConfig = (): RuntimeConfig => {
  const enabled = resolveBoolean(process.env.JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED, false)
  const computeIntervalMs = parsePositiveInt(process.env.JANGAR_TORGHUT_QUANT_COMPUTE_INTERVAL_MS, 1000)
  const heavyComputeIntervalMs = parsePositiveInt(process.env.JANGAR_TORGHUT_QUANT_HEAVY_COMPUTE_INTERVAL_MS, 30_000)
  const seriesSamplingMs = parsePositiveInt(process.env.JANGAR_TORGHUT_QUANT_SERIES_SAMPLING_MS, 5000)
  const streamHeartbeatMs = parsePositiveInt(process.env.JANGAR_TORGHUT_QUANT_STREAM_HEARTBEAT_MS, 15_000)
  const maxStalenessSeconds = parsePositiveInt(process.env.JANGAR_TORGHUT_QUANT_MAX_STALENESS_SECONDS, 15)
  const windowsLight = resolveWindows(process.env.JANGAR_TORGHUT_QUANT_WINDOWS_LIGHT, ['1m', '5m', '15m', '1h', '1d'])
  const windowsHeavy = resolveWindows(process.env.JANGAR_TORGHUT_QUANT_WINDOWS_HEAVY, ['5d', '20d'])
  const alertsEnabled = resolveBoolean(process.env.JANGAR_TORGHUT_QUANT_ALERTS_ENABLED, true)

  return {
    enabled,
    computeIntervalMs,
    heavyComputeIntervalMs,
    seriesSamplingMs,
    streamHeartbeatMs,
    maxStalenessSeconds,
    windowsLight,
    windowsHeavy,
    alertsEnabled,
    policy: {
      maxDrawdown1d: parseNumber(process.env.JANGAR_TORGHUT_QUANT_POLICY_MAX_DRAWDOWN_1D, 0.05),
      minSharpe5d: parseNumber(process.env.JANGAR_TORGHUT_QUANT_POLICY_MIN_SHARPE_5D, 0),
      maxSlippageBps15m: parseNumber(process.env.JANGAR_TORGHUT_QUANT_POLICY_MAX_SLIPPAGE_BPS_15M, 50),
      maxRejectRate15m: parseNumber(process.env.JANGAR_TORGHUT_QUANT_POLICY_MAX_REJECT_RATE_15M, 0.02),
      maxPipelineLagSeconds: parseNumber(process.env.JANGAR_TORGHUT_QUANT_POLICY_MAX_PIPELINE_LAG_SECONDS, 15),
      maxTaFreshnessSeconds: parseNumber(process.env.JANGAR_TORGHUT_QUANT_POLICY_MAX_TA_FRESHNESS_SECONDS, 120),
    },
  }
}

const isMarketHoursNy = (now = new Date()) => {
  // Keep this intentionally coarse: we only want to avoid paging on known off-session staleness.
  // If we later add full market holiday calendars, this should move into a shared market-session helper.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const record: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type] = part.value
  }
  const weekday = record.weekday ?? ''
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hour = Number(record.hour ?? '0')
  const minute = Number(record.minute ?? '0')
  const minutes = hour * 60 + minute
  // 9:30 to 16:00 ET
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60
}

const makeAlertId = (strategyId: string, account: string, metricName: string, window: string) =>
  `torghut-quant:${strategyId}:${account}:${metricName}:${window}`

const evaluateAlerts = (params: {
  frame: QuantSnapshotFrame
  nowIso: string
  policy: RuntimeConfig['policy']
}): AlertEvaluationCandidate[] => {
  const alerts: AlertEvaluationCandidate[] = []
  const marketHours = isMarketHoursNy()

  const metricByName = new Map(params.frame.metrics.map((metric) => [metric.metricName, metric]))
  const maxDrawdown = metricByName.get('max_drawdown')
  if (maxDrawdown?.valueNumeric != null && params.frame.window === '1d') {
    if (Math.abs(maxDrawdown.valueNumeric) > params.policy.maxDrawdown1d) {
      alerts.push({
        breachKey: 'max_drawdown',
        minConsecutive: 2,
        alert: {
          alertId: makeAlertId(params.frame.strategyId, params.frame.account, 'max_drawdown', params.frame.window),
          strategyId: params.frame.strategyId,
          account: params.frame.account,
          severity: 'warning',
          metricName: 'max_drawdown',
          window: params.frame.window,
          threshold: { max_drawdown_1d: params.policy.maxDrawdown1d, consecutive_frames: 2 },
          observed: { value: maxDrawdown.valueNumeric, asOf: maxDrawdown.asOf },
          openedAt: params.nowIso,
          resolvedAt: null,
          state: 'open',
        },
      })
    }
  }

  const sharpe = metricByName.get('sharpe_annualized')
  if (sharpe?.valueNumeric != null && params.frame.window === '5d') {
    if (sharpe.valueNumeric < params.policy.minSharpe5d) {
      alerts.push({
        breachKey: 'sharpe_annualized',
        minConsecutive: 3,
        alert: {
          alertId: makeAlertId(params.frame.strategyId, params.frame.account, 'sharpe_annualized', params.frame.window),
          strategyId: params.frame.strategyId,
          account: params.frame.account,
          severity: 'warning',
          metricName: 'sharpe_annualized',
          window: params.frame.window,
          threshold: { min_sharpe_5d: params.policy.minSharpe5d, consecutive_frames: 3 },
          observed: { value: sharpe.valueNumeric, asOf: sharpe.asOf },
          openedAt: params.nowIso,
          resolvedAt: null,
          state: 'open',
        },
      })
    }
  }

  const slippage = metricByName.get('slippage_bps_vs_mid')
  if (slippage?.valueNumeric != null && params.frame.window === '15m') {
    if (slippage.valueNumeric > params.policy.maxSlippageBps15m) {
      alerts.push({
        breachKey: 'slippage_bps_vs_mid',
        minConsecutive: 1,
        alert: {
          alertId: makeAlertId(
            params.frame.strategyId,
            params.frame.account,
            'slippage_bps_vs_mid',
            params.frame.window,
          ),
          strategyId: params.frame.strategyId,
          account: params.frame.account,
          severity: 'warning',
          metricName: 'slippage_bps_vs_mid',
          window: params.frame.window,
          threshold: { max_slippage_bps_15m: params.policy.maxSlippageBps15m },
          observed: { value: slippage.valueNumeric, asOf: slippage.asOf },
          openedAt: params.nowIso,
          resolvedAt: null,
          state: 'open',
        },
      })
    }
  }

  const rejectRate = metricByName.get('reject_rate')
  if (rejectRate?.valueNumeric != null && params.frame.window === '15m') {
    if (rejectRate.valueNumeric > params.policy.maxRejectRate15m) {
      alerts.push({
        breachKey: 'reject_rate',
        minConsecutive: 1,
        alert: {
          alertId: makeAlertId(params.frame.strategyId, params.frame.account, 'reject_rate', params.frame.window),
          strategyId: params.frame.strategyId,
          account: params.frame.account,
          severity: 'warning',
          metricName: 'reject_rate',
          window: params.frame.window,
          threshold: { max_reject_rate_15m: params.policy.maxRejectRate15m },
          observed: { value: rejectRate.valueNumeric, asOf: rejectRate.asOf },
          openedAt: params.nowIso,
          resolvedAt: null,
          state: 'open',
        },
      })
    }
  }

  // Freshness alerts: only during market hours to avoid false paging.
  if (marketHours) {
    const pipelineLag = metricByName.get('metrics_pipeline_lag_seconds')
    if (pipelineLag?.valueNumeric != null && pipelineLag.valueNumeric > params.policy.maxPipelineLagSeconds) {
      alerts.push({
        breachKey: 'metrics_pipeline_lag_seconds',
        minConsecutive: 1,
        alert: {
          alertId: makeAlertId(
            params.frame.strategyId,
            params.frame.account,
            'metrics_pipeline_lag_seconds',
            params.frame.window,
          ),
          strategyId: params.frame.strategyId,
          account: params.frame.account,
          severity: 'critical',
          metricName: 'metrics_pipeline_lag_seconds',
          window: params.frame.window,
          threshold: { max: params.policy.maxPipelineLagSeconds },
          observed: { value: pipelineLag.valueNumeric, asOf: pipelineLag.asOf },
          openedAt: params.nowIso,
          resolvedAt: null,
          state: 'open',
        },
      })
    }
    const taFreshness = metricByName.get('ta_freshness_seconds')
    if (taFreshness?.valueNumeric != null && taFreshness.valueNumeric > params.policy.maxTaFreshnessSeconds) {
      alerts.push({
        breachKey: 'ta_freshness_seconds',
        minConsecutive: 1,
        alert: {
          alertId: makeAlertId(
            params.frame.strategyId,
            params.frame.account,
            'ta_freshness_seconds',
            params.frame.window,
          ),
          strategyId: params.frame.strategyId,
          account: params.frame.account,
          severity: 'warning',
          metricName: 'ta_freshness_seconds',
          window: params.frame.window,
          threshold: { max: params.policy.maxTaFreshnessSeconds },
          observed: { value: taFreshness.valueNumeric, asOf: taFreshness.asOf },
          openedAt: params.nowIso,
          resolvedAt: null,
          state: 'open',
        },
      })
    }
  }

  return alerts
}

type FrameKey = string

const frameKey = (strategyId: string, account: string, window: string): FrameKey => `${strategyId}:${account}:${window}`

const buildDelta = (previous: QuantSnapshotFrame | null, next: QuantSnapshotFrame): QuantStreamDeltaEvent | null => {
  if (!previous) return null
  const prevByName = new Map(previous.metrics.map((metric) => [metric.metricName, metric]))
  const changed: QuantStreamDeltaEvent['changed'] = []
  for (const metric of next.metrics) {
    const prev = prevByName.get(metric.metricName)
    if (!prev) {
      changed.push({
        metricName: metric.metricName,
        valueNumeric: metric.valueNumeric,
        asOf: metric.asOf,
        quality: metric.quality,
        status: metric.status,
      })
      continue
    }
    if (prev.valueNumeric !== metric.valueNumeric || prev.quality !== metric.quality || prev.status !== metric.status) {
      changed.push({
        metricName: metric.metricName,
        valueNumeric: metric.valueNumeric,
        asOf: metric.asOf,
        quality: metric.quality,
        status: metric.status,
      })
    }
  }
  if (changed.length === 0) return null
  return {
    type: 'quant.metrics.delta',
    strategyId: next.strategyId,
    account: next.account,
    window: next.window,
    changed,
    frameAsOf: next.frameAsOf,
  }
}

const ensureGlobal = () => {
  if (globalState.__torghutQuantRuntime) return globalState.__torghutQuantRuntime
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  globalState.__torghutQuantRuntime = {
    started: false,
    emitter,
    config: loadConfig(),
    lastFrames: new Map(),
    lastSeriesAppendAtMs: new Map(),
    openAlertsByFrame: new Map(),
    alertBreachStreakByFrame: new Map(),
  }
  return globalState.__torghutQuantRuntime
}

export const getTorghutQuantEmitter = () => ensureGlobal().emitter

export const getTorghutQuantStreamHeartbeatMs = () => ensureGlobal().config.streamHeartbeatMs

const resolveStrategyAccountsForCompute = (accounts: string[]) => {
  const normalized = accounts.map((account) => account.trim()).filter(Boolean)
  if (normalized.length === 0) return ['']
  return ['', ...normalized]
}

const runComputeCycle = async (windows: QuantWindow[]) => {
  const state = ensureGlobal()
  const config = state.config

  const torghut = resolveTorghutDb()
  if (!torghut.ok) {
    recordTorghutQuantComputeError('torghut-db-disabled')
    state.emitter.emit('event', { type: 'error', message: torghut.message } satisfies QuantStreamErrorEvent)
    return
  }

  const strategies = await listTorghutTradingStrategies({ pool: torghut.pool, limit: 200 })
  const enabledStrategies = strategies.filter((s) => s.enabled)
  const now = new Date()
  const nowIso = now.toISOString()

  for (const strategy of enabledStrategies) {
    const accounts = await listTorghutStrategyAccounts({ pool: torghut.pool, strategyId: strategy.id, limit: 50 })
    // Always compute an aggregate frame (account='') so the snapshot API works for multi-account strategies.
    const strategyAccounts = resolveStrategyAccountsForCompute(accounts)

    for (const account of strategyAccounts) {
      for (const window of windows) {
        const startedAt = Date.now()
        const computed = await computeTorghutQuantMetrics({
          pool: torghut.pool,
          strategy: { id: strategy.id, name: strategy.name },
          account,
          window,
          now,
          maxStalenessSeconds: config.maxStalenessSeconds,
        })
        const computeDurationMs = Date.now() - startedAt
        recordTorghutQuantComputeDurationMs(computeDurationMs, { window })

        const frame: QuantSnapshotFrame = {
          strategyId: computed.strategyId,
          account: computed.account,
          window: computed.window,
          frameAsOf: computed.frameAsOf,
          metrics: computed.metrics,
          alerts: [],
        }

        // Use the newest metric timestamp as the frame freshness proxy.
        const newestMetric = frame.metrics.reduce<{ asOf: string; freshnessSeconds: number } | null>((acc, metric) => {
          if (!metric.asOf) return acc
          if (!acc) return { asOf: metric.asOf, freshnessSeconds: metric.freshnessSeconds }
          return Date.parse(metric.asOf) > Date.parse(acc.asOf)
            ? { asOf: metric.asOf, freshnessSeconds: metric.freshnessSeconds }
            : acc
        }, null)
        recordTorghutQuantFrame(window, newestMetric?.freshnessSeconds ?? 0, config.maxStalenessSeconds)
        const metricsPipelineLag = frame.metrics.find((metric) => metric.metricName === 'metrics_pipeline_lag_seconds')
        const pipelineLag = metricsPipelineLag?.valueNumeric ?? null

        await upsertQuantLatestMetrics({
          strategyId: frame.strategyId,
          account: frame.account,
          window: frame.window,
          metrics: frame.metrics,
        })

        const fkey = frameKey(frame.strategyId, frame.account, frame.window)
        const lastAppendAt = state.lastSeriesAppendAtMs.get(fkey) ?? 0
        const shouldAppendSeries = Date.now() - lastAppendAt >= config.seriesSamplingMs
        if (shouldAppendSeries) {
          await appendQuantSeriesMetrics({
            strategyId: frame.strategyId,
            account: frame.account,
            window: frame.window,
            metrics: frame.metrics,
          })
          state.lastSeriesAppendAtMs.set(fkey, Date.now())
        }

        const healthAsOf = frame.frameAsOf
        const computeLagSeconds = Math.max(0, Math.ceil(computeDurationMs / 1000))
        const materializationLagSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(frame.frameAsOf)) / 1000))
        await appendQuantPipelineHealth({
          rows: [
            {
              strategyId: frame.strategyId,
              account: frame.account,
              stage: 'ingestion',
              ok: pipelineLag === null ? false : pipelineLag <= config.policy.maxPipelineLagSeconds,
              lagSeconds: pipelineLag === null ? config.policy.maxPipelineLagSeconds + 1 : Math.max(0, pipelineLag),
              asOf: healthAsOf,
              details: { window: frame.window, source: 'torghut-db-and-upstream-signals' },
            },
            {
              strategyId: frame.strategyId,
              account: frame.account,
              stage: 'compute',
              ok: computeLagSeconds <= Math.ceil(config.computeIntervalMs / 1000) + 2,
              lagSeconds: computeLagSeconds,
              asOf: healthAsOf,
              details: {
                window: frame.window,
                metricsCount: frame.metrics.length,
                compute_interval_ms: config.computeIntervalMs,
                heavy_compute_interval_ms: config.heavyComputeIntervalMs,
              },
            },
            {
              strategyId: frame.strategyId,
              account: frame.account,
              stage: 'materialization',
              ok: materializationLagSeconds <= config.maxStalenessSeconds,
              lagSeconds: materializationLagSeconds,
              asOf: healthAsOf,
              details: { window: frame.window, seriesAppended: shouldAppendSeries },
            },
          ],
        })

        if (config.alertsEnabled) {
          const evaluated = evaluateAlerts({ frame, nowIso, policy: config.policy })
          const previousOpen = state.openAlertsByFrame.get(fkey) ?? new Map<string, QuantAlert>()
          const previousStreak = state.alertBreachStreakByFrame.get(fkey) ?? new Map<string, number>()
          const nextStreak = new Map<string, number>()
          const nextOpen = new Map<string, QuantAlert>()
          const breachedKeys = new Set<string>()

          for (const candidate of evaluated) {
            breachedKeys.add(candidate.breachKey)
            const currentStreak = (previousStreak.get(candidate.breachKey) ?? 0) + 1
            nextStreak.set(candidate.breachKey, currentStreak)
            if (currentStreak >= candidate.minConsecutive) {
              nextOpen.set(candidate.alert.alertId, candidate.alert)
            }
          }

          for (const [key] of previousStreak) {
            if (!breachedKeys.has(key)) nextStreak.set(key, 0)
          }

          const updates: QuantAlert[] = []

          for (const [alertId, alert] of nextOpen) {
            const prev = previousOpen.get(alertId)
            const isNewlyOpened = !prev
            if (prev) {
              // Preserve original open timestamp.
              if (prev.openedAt) alert.openedAt = prev.openedAt
            }
            updates.push(alert)
            if (isNewlyOpened) {
              state.emitter.emit('event', { type: 'quant.alert.opened', alert } satisfies QuantStreamAlertEvent)
            }
          }

          for (const [alertId, prev] of previousOpen) {
            if (nextOpen.has(alertId)) continue
            updates.push({
              ...prev,
              state: 'resolved',
              resolvedAt: nowIso,
            })
            state.emitter.emit('event', {
              type: 'quant.alert.resolved',
              alert: { ...prev, state: 'resolved', resolvedAt: nowIso },
            } satisfies QuantStreamAlertEvent)
          }

          if (updates.length > 0) {
            await upsertQuantAlerts({ alerts: updates })
          }

          frame.alerts = [...nextOpen.values()]
          state.openAlertsByFrame.set(fkey, nextOpen)
          state.alertBreachStreakByFrame.set(fkey, nextStreak)
        }

        const previous = state.lastFrames.get(fkey) ?? null
        state.lastFrames.set(fkey, frame)

        state.emitter.emit('event', { type: 'quant.metrics.snapshot', frame } satisfies QuantStreamSnapshotEvent)
        const delta = buildDelta(previous, frame)
        if (delta) state.emitter.emit('event', delta)
      }
    }
  }
}

export const startTorghutQuantRuntime = () => {
  const state = ensureGlobal()
  if (state.started) return
  state.started = true
  state.config = loadConfig()

  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return
  if (!state.config.enabled) return

  let lightInFlight = false
  setInterval(() => {
    if (lightInFlight) return
    lightInFlight = true
    void runComputeCycle(state.config.windowsLight)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        recordTorghutQuantComputeError('light-cycle')
        state.emitter.emit('event', { type: 'error', message } satisfies QuantStreamErrorEvent)
      })
      .finally(() => {
        lightInFlight = false
      })
  }, state.config.computeIntervalMs)

  let heavyInFlight = false
  setInterval(() => {
    if (heavyInFlight) return
    heavyInFlight = true
    void runComputeCycle(state.config.windowsHeavy)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        recordTorghutQuantComputeError('heavy-cycle')
        state.emitter.emit('event', { type: 'error', message } satisfies QuantStreamErrorEvent)
      })
      .finally(() => {
        heavyInFlight = false
      })
  }, state.config.heavyComputeIntervalMs)
}

export const __private = {
  resolveStrategyAccountsForCompute,
  evaluateAlerts,
  buildDelta,
}
