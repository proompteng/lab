import {
  allocationLookback,
  equity,
  grossCap,
  sellFee,
  type Sleeve,
  type Trial,
  type Weight,
} from './intraday-v3-protocol'
import { type Order, type PreparedDay } from './intraday-v3-signals'
import { mean } from './midday-research-statistics'

type Engine = Sleeve['engine']
type Allocation = Readonly<Record<Engine, number>>
export const engines = ['orb', 'reversion', 'noise'] as const
const uniformSolo = { orb: 1, reversion: 1, noise: 1 }

const maxSlip = 10 / 20_000
const cash = () => ({
  netBeforeSlippage: 0,
  turnoverAfterFee: 0,
  trades: 0,
  unresolved: 0,
  canceledMissing: 0,
  heldGaps: 0,
  conflicts: 0,
  capSkips: 0,
  peakGross: 0,
})
export type Ledger = ReturnType<typeof cash>
export const netAt = (ledger: Ledger, bps: number) =>
  ledger.unresolved > 0 ? null : ledger.netBeforeSlippage - (ledger.turnoverAfterFee * bps) / 20_000

export const sleeveWeights = (mode: Weight, active: readonly Engine[], dailyVol: Allocation): Allocation => {
  const allocation = { orb: 0, reversion: 0, noise: 0 }
  const baseline = 1 / active.length
  for (const engine of active) {
    switch (mode) {
      case 'orb-tilt':
      case 'reversion-tilt': {
        const tilted = active.length === 2 ? 0.75 : 0.5
        allocation[engine] =
          engine === (mode === 'orb-tilt' ? 'orb' : 'reversion') ? tilted : (1 - tilted) / (active.length - 1)
        break
      }
      case 'equal':
        allocation[engine] = baseline
        break
      case 'risk-parity':
        allocation[engine] = 1 / Math.max(0.0025, dailyVol[engine])
        break
      case 'inverse-variance':
        allocation[engine] = baseline * Math.min(2, (0.005 / Math.max(0.0025, dailyVol[engine])) ** 2)
        break
    }
  }
  const total = allocation.orb + allocation.reversion + allocation.noise
  if (mode === 'risk-parity' || total > 1) for (const engine of active) allocation[engine] /= total
  return allocation
}

// Only standalone, completed prior sessions may contribute to the next session's allocation.
export const laggedVol = (days: readonly Ledger[]) =>
  days.map((_, index) => {
    const previous = days.slice(Math.max(0, index - allocationLookback), index).map((day) => netAt(day, 10))
    if (previous.length !== allocationLookback || previous.some((net) => net === null)) return null
    const center = mean(previous)
    return Math.sqrt(previous.reduce((sum, net) => sum + ((net - center) / equity) ** 2, 0) / (allocationLookback - 1))
  })

interface OpenPosition {
  readonly symbol: string
  readonly reserved: number
  readonly exitSlot: number
  readonly exitAtOpen: boolean
}

export const replayDay = (day: PreparedDay, trial: Trial, weights: Allocation, omitted = ''): Ledger => {
  const ledger = cash()
  const orb = trial.engine === 'portfolio' ? trial.orb : trial.engine === 'orb' ? trial : null
  const noise = trial.engine === 'portfolio' ? trial.noise : trial.engine === 'noise' ? trial : null
  const reversion = trial.engine === 'portfolio' ? trial.reversion : trial.engine === 'reversion' ? trial : null
  const orders = [
    ...(orb === null ? [] : day.orb(orb, omitted)),
    ...(noise === null ? [] : day.noise(noise, omitted)),
  ].sort((a, b) => a.start - b.start || (a.engine === b.engine ? 0 : a.engine === 'orb' ? -1 : 1))
  let held: OpenPosition[] = []
  const removeExits = (slot: number) => {
    held = held.filter((position) => position.exitSlot > slot || (position.exitSlot === slot && !position.exitAtOpen))
  }
  const proposed = (order: Order, available: number) => {
    const fill = order.fill
    if (fill === null || fill === 'missing') return null
    const weight = weights[order.engine]
    let cap = (weight * grossCap) / 4
    let riskShares = Infinity
    if (order.riskDistance !== null) {
      const top = order.engine === 'orb' ? (orb?.top ?? 1) : 2
      const risk = order.engine === 'orb' ? 1_000 : 1_500
      cap = weight * Math.min(60_000, grossCap / top)
      riskShares = (weight * risk) / (top * order.riskDistance)
    }
    if (order.engine === 'reversion' && available <= 0) return null
    const reservationPrice = fill.entry * (1 + maxSlip)
    const shares = Math.min(riskShares, cap / order.reference, cap / reservationPrice, available / reservationPrice)
    const qty = order.engine === 'reversion' ? Math.min(cap, available) / reservationPrice : Math.floor(shares)
    return qty > 0 ? { order, fill, qty, reserved: qty * reservationPrice } : null
  }
  const available = () => Math.max(0, grossCap - held.reduce((sum, position) => sum + position.reserved, 0))
  const record = ({ order, fill, qty, reserved }: NonNullable<ReturnType<typeof proposed>>) => {
    if (held.some((position) => position.symbol === order.symbol))
      throw new Error(`Duplicate position: ${order.symbol}`)
    held.push({ symbol: order.symbol, reserved, exitSlot: fill.exitSlot, exitAtOpen: fill.exitAtOpen })
    const gross = held.reduce((sum, position) => sum + position.reserved, 0)
    if (gross > grossCap + 1e-8) throw new Error(`Gross cap exceeded: ${gross}`)
    ledger.peakGross = Math.max(ledger.peakGross, gross)
    ledger.heldGaps += fill.gaps
    if (fill.exit === null) {
      ledger.unresolved++
      return
    }
    ledger.trades++
    const sell = qty * (order.side === 1 ? fill.exit : fill.entry)
    ledger.netBeforeSlippage += qty * order.side * (fill.exit - fill.entry) - sell * sellFee
    ledger.turnoverAfterFee += qty * (fill.entry + fill.exit) - sell * sellFee
  }

  const single = (order: Order) => {
    removeExits(order.start)
    if (held.some((position) => position.symbol === order.symbol)) {
      ledger.conflicts++
      return
    }
    if (order.fill === 'missing') {
      ledger.canceledMissing++
      return
    }
    const intent = proposed(order, available())
    if (intent !== null) record(intent)
    else if (proposed(order, grossCap) !== null) ledger.capSkips++
  }

  const noon = (slot: number, sameOpen: readonly Order[]) => {
    if (reversion === null) return
    const excluded = new Set(held.filter((position) => position.exitSlot >= slot).map(({ symbol }) => symbol))
    // A same-open OR5 intent already exists at this information cutoff, even if its fill later fails.
    for (const order of sameOpen) excluded.add(order.symbol)
    if (omitted !== '') excluded.add(omitted)
    const basket = day.reversion(reversion, excluded)
    // The signal was ranked before open-time exits were observable; capacity can recycle at the open.
    for (const order of sameOpen) single(order)
    removeExits(slot)
    if (basket.length === 0) return
    if (basket.some((order) => order.fill === 'missing')) {
      ledger.canceledMissing += basket.filter((order) => order.fill === 'missing').length
      return
    }
    // Atomic 2L+2S: identical reserved dollars per leg, no orphan on missing opens.
    const cap = available() / 4
    const intents = basket.map((order) => proposed(order, cap))
    if (intents.every((intent) => intent !== null)) for (const intent of intents) record(intent)
    else if (cap <= 0 && basket.every((order) => proposed(order, grossCap) !== null)) ledger.capSkips += basket.length
  }

  const noonSlot = reversion === null ? Infinity : reversion.signalSlot + 1
  for (const order of orders) if (order.start < noonSlot) single(order)
  if (reversion !== null)
    noon(
      noonSlot,
      orders.filter((order) => order.start === noonSlot),
    )
  for (const order of orders) if (order.start > noonSlot) single(order)
  return ledger
}

export const replayBook = (
  days: readonly PreparedDay[],
  trials: readonly Trial[],
  omitted = '',
  signal?: AbortSignal,
) => {
  const outcomes = new Map<string, readonly Ledger[]>()
  const vols = new Map<string, readonly (number | null)[]>()
  for (const trial of trials) {
    signal?.throwIfAborted()
    if (trial.engine !== 'portfolio') {
      const daily = days.map((day) => replayDay(day, trial, uniformSolo, omitted))
      outcomes.set(trial.id, daily)
      vols.set(trial.id, laggedVol(daily))
      continue
    }
    const orbVol = vols.get(trial.orb.id)
    const reversionVol = vols.get(trial.reversion.id)
    const noiseVol = trial.noise === null ? null : vols.get(trial.noise.id)
    if (!orbVol || !reversionVol || noiseVol === undefined)
      throw new Error('Portfolio shadow ledger must precede portfolio')
    const active = trial.noise === null ? (['orb', 'reversion'] as const) : engines
    const staticMode = trial.weight === 'equal' || trial.weight === 'orb-tilt' || trial.weight === 'reversion-tilt'
    const staticWeights = sleeveWeights(staticMode ? trial.weight : 'equal', active, uniformSolo)
    outcomes.set(
      trial.id,
      days.map((day, i) => {
        const orb = orbVol[i]
        const reversion = reversionVol[i]
        const noise = noiseVol === null ? 0 : noiseVol[i]
        const allocation =
          staticMode || orb === null || reversion === null || noise === null
            ? staticWeights
            : sleeveWeights(trial.weight, active, { orb, reversion, noise })
        return replayDay(day, trial, allocation, omitted)
      }),
    )
  }
  return outcomes
}
