import type { IntradayDay } from './pure-etf-dual-horizon-data'

export const noiseRosters = {
  I1: ['QQQ', 'SMH'],
  I2: ['IWM', 'QQQ', 'SMH', 'SPY'],
} as const
export type NoiseId = keyof typeof noiseRosters

const history = 14
const checkpoints = Array.from({ length: 11 }, (_, i) => (i + 1) * 6 - 1)
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
export type NoiseOrder = {
  symbol: string
  side: 1 | -1
  atr: number
  reference: number
  entrySlot: number
  exitSlot: number
  entry: number | undefined
  exit: number | undefined
  heldGaps: number
  exitSource?: 'sip-execution-supplement'
}
type Prior = { close: number; tr: number; moves: readonly number[] }

// Wave 5A C5 eqs (73b26d5ad). Preserve session warm-up, band, checkpoints,
// next-open entry/exit, and the first signal only, including when a fill is absent.
export const noiseOrders = (days: readonly IntradayDay[]) => {
  const priorBySymbol = new Map<string, Prior[]>()
  return days.map((day) => {
    const orders: NoiseOrder[] = []
    const ready: string[] = []
    const incomplete: string[] = []
    for (const symbol of noiseRosters.I2) {
      const bars = day.bars.get(symbol)
      const prior = priorBySymbol.get(symbol) ?? []
      const open = bars?.[0]?.open
      if (bars === undefined || open === undefined) {
        incomplete.push(symbol)
        priorBySymbol.delete(symbol)
        continue
      }
      const previousClose = prior.at(-1)?.close ?? open
      if (prior.length === history) {
        ready.push(symbol)
        const atr = mean(prior.map(({ tr }) => tr))
        const bands = new Map(checkpoints.map((slot, j) => [slot, 1.2 * mean(prior.map(({ moves }) => moves[j]))]))
        const direction = (slot: number) => {
          const band = bands.get(slot) ?? NaN
          const close = bars[slot]?.close
          if (!(band > 0) || close === undefined) return 0
          if (close > Math.max(open, previousClose) * (1 + band)) return 1
          if (close < Math.min(open, previousClose) * (1 - band)) return -1
          return 0
        }
        const flat = day.slots - 1 // Latest 5m open at or before actual close minus two minutes.
        for (const signalSlot of checkpoints) {
          const entrySlot = signalSlot + 1
          if (entrySlot >= flat || atr <= 0) break
          const side = direction(signalSlot)
          const reference = bars[signalSlot]?.close
          if (side === 0 || reference === undefined) continue
          const reversal = checkpoints.find((slot) => slot >= entrySlot && slot < flat && direction(slot) === -side)
          const exitSlot = reversal === undefined ? flat : reversal + 1
          let heldGaps = 0
          for (let slot = entrySlot; slot < exitSlot; slot++) {
            if (bars[slot] === undefined) heldGaps++
          }
          orders.push({
            symbol,
            side,
            atr,
            reference,
            entrySlot,
            exitSlot,
            entry: bars[entrySlot]?.open,
            exit: bars[exitSlot]?.open,
            heldGaps,
          })
          break
        }
      }
      let high = previousClose
      let low = previousClose
      let close: number | undefined
      for (let slot = 0; slot < day.slots; slot++) {
        const current = bars[slot]
        if (current === undefined) {
          close = undefined
          break
        }
        high = Math.max(high, current.high)
        low = Math.min(low, current.low)
        close = current.close
      }
      if (close === undefined) {
        incomplete.push(symbol)
        priorBySymbol.delete(symbol)
      } else {
        prior.push({
          close,
          tr: high - low,
          moves: checkpoints.map((slot) => {
            const price = bars[slot]?.close
            return price === undefined ? NaN : Math.abs(price / open - 1)
          }),
        })
        if (prior.length > history) prior.shift()
        priorBySymbol.set(symbol, prior)
      }
    }
    return {
      orders: orders.sort((a, b) => a.entrySlot - b.entrySlot || a.symbol.localeCompare(b.symbol, 'en')),
      ready,
      incomplete,
    }
  })
}

// Execution-only recovery, not a backfill of signal history. The original archive
// has no IWM bars after 19:30 UTC on this date. The 14:00 UTC overlap is identical.
export const executionSupplement = {
  provider: 'Alpaca Market Data',
  feed: 'sip',
  timeframe: '5Min',
  symbol: 'IWM',
  date: '2019-08-12',
  anchor: { timestamp: '2019-08-12T14:00:00Z', slot: 6, open: 148.978, high: 149.225, low: 148.93, close: 149.01 },
  exit: { timestamp: '2019-08-12T19:55:00Z', slot: 77, open: 148.79, high: 148.825, low: 148.63, close: 148.67 },
} as const

export const bindExitSupplement = (day: IntradayDay, orders: readonly NoiseOrder[]): readonly NoiseOrder[] => {
  const { date, symbol, anchor, exit } = executionSupplement
  if (day.date !== date) return orders
  const bars = day.bars.get(symbol)
  const original = bars?.[anchor.slot]
  if (
    original?.open !== anchor.open ||
    original.high !== anchor.high ||
    original.low !== anchor.low ||
    original.close !== anchor.close ||
    bars?.[exit.slot] !== undefined ||
    day.slots - 1 !== exit.slot
  )
    throw new Error(`Execution supplement conflicts with frozen tape: ${date} ${symbol}`)
  let bound = 0
  const result = orders.map((order) => {
    if (
      order.symbol !== symbol ||
      order.exitSlot !== exit.slot ||
      order.exit !== undefined ||
      order.entrySlot !== anchor.slot ||
      order.entry !== anchor.open
    )
      return order
    bound++
    return { ...order, exit: exit.open, exitSource: 'sip-execution-supplement' } as const
  })
  if (bound !== 1) throw new Error(`Expected one frozen order for execution supplement: ${date} ${symbol}`)
  return result
}
