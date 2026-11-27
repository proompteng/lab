import {
  capital,
  frictionBps,
  intradayLimit,
  noIntraday,
  reservationScale,
  sellFee,
  type Intraday,
} from './master-portfolio-account'
import { type Order, type PreparedDay } from './master-portfolio-intraday-signals'

const orb = { engine: 'orb', top: 1, rvol: 2.5, target: 2 } as const
const reversion = { engine: 'reversion', signalSlot: 29, gate: 'iqr', minBps: 100, exit: 'eod' } as const
const noise = { engine: 'noise', id: 'noise/1.2/opposite', band: 1.2, exit: 'opposite' } as const

// Locked Wave 3B OR5 tilt; allocations apply to the standalone $180k reservation and $1k/$1.5k stop budgets.
export const replay3B =
  (days: ReadonlyMap<string, PreparedDay>, engines: 2 | 3): Intraday =>
  ({ date, budget, capacity, dtbp, overnightGross, overnightSymbols, tier }) => {
    const day = days.get(date)
    if (day === undefined) throw new Error(`Missing Wave 3B session ${date}`)
    if (budget === 0) return noIntraday
    const weights =
      engines === 3 ? { orb: 0.5, reversion: 0.25, noise: 0.25 } : { orb: 0.75, reversion: 0.25, noise: 0 }
    const orders = [...day.orb(orb, overnightSymbols), ...(engines === 3 ? day.noise(noise, overnightSymbols) : [])]
    const noon = reversion.signalSlot + 1
    const slots = [...new Set([noon, ...orders.map((order) => order.start)])].sort((a, b) => a - b)
    let held: { symbol: string; reserved: number; exitSlot: number; exitAtOpen: boolean }[] = []
    let peakGross = 0
    let trades = 0
    let missing = 0
    let scaled = false
    let grossCapHit = false
    let dtbpHit = false
    let net = 0
    for (const slot of slots) {
      const sameOpen = orders.filter((order) => order.start === slot)
      // Reversion ranks before current-open exits can recycle capacity. Prior intents keep their symbols.
      const basket =
        slot === noon
          ? day.reversion(
              reversion,
              new Set([
                ...overnightSymbols,
                ...held.filter((position) => position.exitSlot >= slot).map(({ symbol }) => symbol),
                ...sameOpen.map(({ symbol }) => symbol),
              ]),
            )
          : []
      held = held.filter((position) => position.exitSlot > slot || (position.exitSlot === slot && !position.exitAtOpen))
      const proposal = (order: Order) => {
        if (order.fill === 'missing') {
          missing++
          return []
        }
        if (order.fill === null || held.some(({ symbol }) => symbol === order.symbol)) return []
        const fraction = (weights[order.engine] * budget) / capital
        const { entry } = order.fill
        const bps = frictionBps(order.symbol, tier)
        const reservePrice = entry * (1 + bps / 20_000)
        const cap = fraction * (order.engine === 'reversion' ? 45_000 : 60_000)
        const size =
          order.riskDistance === null
            ? cap / reservePrice
            : Math.min(
                cap / order.reference,
                cap / reservePrice,
                (fraction * (order.engine === 'orb' ? 1_000 : 750)) / order.riskDistance,
              )
        return [{ order, fill: order.fill, reservePrice, size, bps }]
      }
      const intents = sameOpen.flatMap(proposal)
      const basketIntents = basket.flatMap(proposal)
      if (basketIntents.length === 4) intents.push(...basketIntents)
      const active = held.reduce((sum, { reserved }) => sum + reserved, 0)
      const requested = intents.reduce((sum, { size, reservePrice }) => sum + size * reservePrice, 0)
      const want = active + requested
      if (requested > 0) {
        grossCapHit ||= want + overnightGross > intradayLimit + 1e-8
        dtbpHit ||= want > dtbp + 1e-8
      }
      const scale = reservationScale(requested, active, capacity)
      scaled ||= scale < 1
      let admitted = active
      for (const { order, fill, reservePrice, size, bps } of intents) {
        const shares = order.engine === 'reversion' ? size * scale : Math.floor(size * scale)
        if (!(shares > 0)) continue
        if (fill.exit === null) throw new Error(`Unresolved Wave 3B exit: ${order.symbol} ${date}`)
        const reserved = shares * reservePrice
        admitted += reserved
        held.push({ symbol: order.symbol, reserved, exitSlot: fill.exitSlot, exitAtOpen: fill.exitAtOpen })
        const sell = order.side === 1 ? fill.exit : fill.entry
        net +=
          shares * (order.side * (fill.exit - fill.entry) - sell * sellFee - ((fill.entry + fill.exit) * bps) / 20_000)
        trades++
      }
      if (admitted > capacity + 1e-8) throw new Error(`Intraday reservation over capacity on ${date}`)
      peakGross = Math.max(peakGross, admitted)
    }
    return { net, peakGross, trades, missing, scaled, grossCapHit, dtbpHit }
  }
