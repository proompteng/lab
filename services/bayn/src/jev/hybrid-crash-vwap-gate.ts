/**
 * RESEARCH hybrid producer: crash ∩ VWAP + bounce confirm.
 *
 * Schema: bayn.hybrid-crash-vwap.shadow.v1
 * Status: RESEARCH_ONLY — never changes live fills.
 *
 * Env BAYN_HYBRID_CRASH_VWAP: off | shadow | on
 *   off (default) — no-op
 *   shadow / on   — evaluate + return compare record (on coerced to shadow)
 *
 * Frozen params match docs/bayn/research-candidate-crash-vwap-bounce-v1.md
 * Evidence: docs/bayn/evidence/2026-10-07-hybrid-hf-v5/
 */

export const hybridCrashVwapSchemaVersion = 'bayn.hybrid-crash-vwap.shadow.v1' as const
export const hybridCrashVwapModel = 'crash-vwap-bounce-1.0.0' as const

/** Frozen research definition — do not retune without a new candidate id. */
export const hybridCrashVwapParams = {
  crashBp: 80,
  vwapDistBp: 60,
  ageMinMinutes: 30,
  bounceBars: 1,
  holdMinutes: 90,
  stopBp: 50,
  rthOpenMinutes: 9 * 60 + 30, // 09:30 ET as minute-of-day
  flattenMinutes: 15 * 60 + 55, // 15:55 ET
} as const

export type HybridCrashVwapMode = 'off' | 'shadow'

export type HybridBar = {
  readonly symbol: string
  /** Minutes from midnight in America/New_York (RTH clock). */
  readonly minuteOfDay: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export type HybridCrashVwapCandidate = {
  readonly symbol: string
  readonly signalMinuteOfDay: number
  readonly entryMinuteOfDay: number
  readonly crashBp: number
  readonly vwapDistBp: number
  readonly sessionVwap: number
  readonly signalClose: number
  readonly entryClose: number
}

export type HybridCrashVwapShadowRecord = {
  readonly schemaVersion: typeof hybridCrashVwapSchemaVersion
  readonly model: typeof hybridCrashVwapModel
  readonly mode: HybridCrashVwapMode
  readonly sessionDate: string
  readonly evaluatedAt: string
  readonly params: typeof hybridCrashVwapParams
  readonly candidates: readonly HybridCrashVwapCandidate[]
  readonly note: 'RESEARCH_ONLY_no_live_fills'
}

const parseMode = (raw: string | undefined): HybridCrashVwapMode => {
  const v = (raw ?? 'off').trim().toLowerCase()
  if (v === 'shadow' || v === 'on') return 'shadow'
  return 'off'
}

export const resolveHybridCrashVwapMode = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): HybridCrashVwapMode => parseMode(env.BAYN_HYBRID_CRASH_VWAP)

/** Session VWAP from typical price × volume (honest cumulative). */
export const sessionVwapSeries = (bars: readonly HybridBar[]): number[] => {
  const out: number[] = []
  let pv = 0
  let vv = 0
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * b.volume
    vv += b.volume
    out.push(vv > 0 ? pv / vv : b.close)
  }
  return out
}

/**
 * Scan one symbol's RTH bars (sorted ascending by minuteOfDay).
 * Bounce confirm waits +bounceBars and requires close rebound — no same-bar lookahead entry.
 */
export const collectCrashVwapBounceCandidates = (
  bars: readonly HybridBar[],
  params: typeof hybridCrashVwapParams = hybridCrashVwapParams,
): HybridCrashVwapCandidate[] => {
  if (bars.length < 3) return []
  const vwap = sessionVwapSeries(bars)
  const out: HybridCrashVwapCandidate[] = []
  for (let i = 1; i < bars.length; i++) {
    const age = bars[i]!.minuteOfDay - params.rthOpenMinutes
    if (age < params.ageMinMinutes) continue
    if (bars[i]!.minuteOfDay >= params.flattenMinutes - 5) continue
    const prev = bars[i - 1]!.close
    if (prev <= 0) continue
    const crashBp = (bars[i]!.close / prev - 1) * 1e4
    const distBp = (bars[i]!.close / vwap[i]! - 1) * 1e4
    if (crashBp > -params.crashBp || distBp > -params.vwapDistBp) continue
    const j = i + params.bounceBars
    if (j >= bars.length) continue
    if (bars[j]!.close <= bars[i]!.close) continue
    if (bars[j]!.minuteOfDay >= params.flattenMinutes - 2) continue
    out.push({
      symbol: bars[i]!.symbol,
      signalMinuteOfDay: bars[i]!.minuteOfDay,
      entryMinuteOfDay: bars[j]!.minuteOfDay,
      crashBp,
      vwapDistBp: distBp,
      sessionVwap: vwap[i]!,
      signalClose: bars[i]!.close,
      entryClose: bars[j]!.close,
    })
  }
  return out
}

export const evaluateHybridCrashVwapShadow = (input: {
  readonly sessionDate: string
  readonly barsBySymbol: Readonly<Record<string, readonly HybridBar[]>>
  readonly evaluatedAt?: string
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}): HybridCrashVwapShadowRecord | null => {
  const mode = resolveHybridCrashVwapMode(input.env)
  if (mode === 'off') return null
  const candidates: HybridCrashVwapCandidate[] = []
  for (const symbol of Object.keys(input.barsBySymbol).sort()) {
    const bars = input.barsBySymbol[symbol]
    if (bars === undefined || bars.length === 0) continue
    candidates.push(...collectCrashVwapBounceCandidates(bars))
  }
  candidates.sort(
    (a, b) => a.entryMinuteOfDay - b.entryMinuteOfDay || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  )
  return {
    schemaVersion: hybridCrashVwapSchemaVersion,
    model: hybridCrashVwapModel,
    mode,
    sessionDate: input.sessionDate,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    params: hybridCrashVwapParams,
    candidates,
    note: 'RESEARCH_ONLY_no_live_fills',
  }
}
