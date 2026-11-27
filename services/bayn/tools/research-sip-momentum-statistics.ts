import { dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'
import { costs, periods } from './research-sip-momentum-protocol'
import { netAt, type Daily } from './research-sip-momentum-replay'

export const bootstrap = { replicates: 10_000, blockDays: 5, seed: 0x2f12cb61 } as const

interface Draws {
  readonly starts: Uint16Array
  readonly partial: Uint16Array
}

const drawsByLength = new Map<number, Draws>()
const drawIndices = (n: number): Draws => {
  const cached = drawsByLength.get(n)
  if (cached !== undefined) return cached
  let state: number = bootstrap.seed
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
  const blocks = Math.floor(n / bootstrap.blockDays)
  const starts = new Uint16Array(bootstrap.replicates * blocks)
  const partial = new Uint16Array(n % bootstrap.blockDays === 0 ? 0 : bootstrap.replicates)
  let k = 0
  for (let i = 0; i < bootstrap.replicates; i++) {
    for (let j = 0; j < blocks; j++) starts[k++] = next()
    if (partial.length > 0) partial[i] = next()
  }
  const draws = { starts, partial }
  drawsByLength.set(n, draws)
  return draws
}

export const blockP = (values: readonly number[]): number | null => {
  const n = values.length
  if (n < 2 * bootstrap.blockDays || n > 65_535) return null
  const observed = values.reduce((total, value) => total + value, 0)
  if (values.every((value) => value === values[0])) return observed > 0 ? 1 / (1 + bootstrap.replicates) : 1
  const mean = observed / n
  const prefix = new Float64Array(n * 2 + 1)
  for (let i = 0; i < n * 2; i++) prefix[i + 1] = prefix[i] + values[i % n] - mean
  const blocks = Math.floor(n / bootstrap.blockDays)
  const remainder = n % bootstrap.blockDays
  const sums = Float64Array.from(values, (_, i) => prefix[i + bootstrap.blockDays] - prefix[i])
  const { starts, partial } = drawIndices(n)
  let tails = 0
  let offset = 0
  for (let trial = 0; trial < bootstrap.replicates; trial++) {
    let sampled = 0
    const end = offset + blocks
    for (; offset < end; offset++) sampled += sums[starts[offset]]
    if (remainder > 0) {
      const start = partial[trial]
      sampled += prefix[start + remainder] - prefix[start]
    }
    if (sampled >= observed) tails++
  }
  return (1 + tails) / (1 + bootstrap.replicates)
}

export type Period = keyof typeof periods
export const windowOrder = Object.keys(periods) as Period[]
export const developmentWindows = ['train', 'validation'] as const
export const halfYears = windowOrder.slice(3)
export type Cost = (typeof costs)[number]
export const gateCosts = [5, 10] as const

export const windows = (dates: readonly string[], order: readonly Period[]) =>
  order.map((period) => {
    const [start, end] = periods[period]
    const first = dates.findIndex((date) => date >= start)
    const last = dates.findLastIndex((date) => date <= end)
    if (first < 0 || last < first) throw new Error(`Empty SIP research window: ${period}`)
    return { period, first, end: last + 1 }
  })

export const known = (day: Daily) => day.unresolved === 0 && day.missingEntry === 0

export const basic = (days: readonly Daily[], bps: Cost) => {
  const values = days.filter(known).map((day) => netAt(day, bps))
  const complete = values.length === days.length
  const supportedNet = days.reduce((total, day) => total + netAt(day, bps), 0)
  const observed = values.reduce((total, value) => total + value, 0)
  const sorted = values.filter((value) => value > 0).sort((a, b) => b - a)
  const trimmed = (n: number) =>
    complete && days.length > n ? observed - sorted.slice(0, n).reduce((total, value) => total + value, 0) : null
  let cumulative = 0
  let peak = 0
  let drawdown = 0
  for (const value of values) {
    cumulative += value
    peak = Math.max(peak, cumulative)
    drawdown = Math.max(drawdown, peak - cumulative)
  }
  return {
    values,
    complete,
    net: complete ? observed : null,
    supportedNet,
    exTop5: trimmed(5),
    exTop10: trimmed(10),
    dailySharpe: complete ? dailySharpe(values) : null,
    drawdown: complete ? drawdown : null,
  }
}

export const metricColumns = [
  'netUsd',
  'supportedClosedNetUsd',
  'exTop5Usd',
  'exTop10Usd',
  'annualizedSharpe',
  'maxDrawdownUsd',
  'blockP',
  'dsr',
] as const

export const metrics = (days: readonly Daily[], bps: Cost, benchmark: number | null) => {
  const row = basic(days, bps)
  return [
    row.net,
    row.supportedNet,
    row.exTop5,
    row.exTop10,
    row.dailySharpe === null ? null : row.dailySharpe * Math.sqrt(252),
    row.drawdown,
    row.complete ? blockP(row.values) : null,
    row.complete ? deflatedSharpe(row.values, benchmark) : null,
  ]
}

export const coverageColumns = [
  'sessions',
  'activeSessions',
  'closedLegs',
  'unresolvedLegs',
  'missingEntries',
  'peakEntryNotional',
] as const
export const coverage = (days: readonly Daily[]) => [
  days.length,
  days.filter((day) => day.entryNotional > 0).length,
  days.reduce((n, day) => n + day.trades, 0),
  days.reduce((n, day) => n + day.unresolved, 0),
  days.reduce((n, day) => n + day.missingEntry, 0),
  Math.max(0, ...days.map((day) => day.entryNotional)),
]
