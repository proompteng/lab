import { Data, DateTime, Option, Result, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { intradayInstantNanos } from '../src/market-data/intraday/time'
import { EquityCutFeed, SipDelayClass, sipTopics } from '../src/market-data/sip/provenance'
import { isSipCollectedSymbol, sipUniverse, type SipSymbol } from '../src/market-data/sip/universe'
import {
  IsoDateSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  Sha256Schema,
  SignalRowSymbolSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcSourceTimestampSchema,
  strictParseOptions,
} from '../src/schemas'

const minuteNs = 60_000_000_000n
const staleNs = 5_000_000_000n
const completeRatio = 0.995
const maxQuoteLatencyMs = 2_000
const maxMedianSpreadBps = 2
const spreadSymbols = ['QQQ', 'SMH', 'XLK'] as const
const coverageSymbols = [...spreadSymbols, ...sipUniverse.benchmarks] as const
const { Iex, Sip } = EquityCutFeed

export const iexTopics = { bars: 'torghut.bars.1m.v1', quotes: 'torghut.quotes.v1' } as const
export const maxBars = 500_000
export const maxQuotes = 30_000_000

enum IexDelayClass {
  RealTimeExchangeOnly = 'real_time_exchange_only',
}

const archiveIdentity = {
  provider: Schema.Literal('alpaca'),
  feed: Schema.Enum(EquityCutFeed),
  delay_class: Schema.Union([Schema.Enum(SipDelayClass), Schema.Enum(IexDelayClass)]),
  source_topic: StrictNonEmptyStringSchema,
  universe_id: StrictNonEmptyStringSchema,
  universe_symbol_hash: Sha256Schema,
  symbol: SignalRowSymbolSchema,
  event_at: UtcSourceTimestampSchema,
  ingested_at: UtcSourceTimestampSchema,
  schema_version: Schema.Literal(1),
}
type ArchiveIdentity = Schema.Struct.Type<typeof archiveIdentity>

const checkRoute = (kind: keyof typeof iexTopics) =>
  Schema.makeFilter(
    (row: ArchiveIdentity) =>
      row.feed === Sip
        ? row.source_topic === sipTopics[kind] && row.delay_class === SipDelayClass.RealTimeConsolidated
        : row.source_topic === iexTopics[kind] && row.delay_class === IexDelayClass.RealTimeExchangeOnly,
    { expected: 'consistent archive topic, feed and delay class' },
  )

const BarSchema = Schema.Struct({
  ...archiveIdentity,
  is_final: Schema.Literals([0, 1]),
  source_partition: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(2_147_483_647)),
  source_offset: UnsignedMicrosSchema.check(
    Schema.makeFilter((value) => BigInt(value) <= 9_223_372_036_854_775_807n, { expected: 'a Kafka offset' }),
  ),
  close: PositiveFiniteSchema,
}).check(checkRoute('bars'))

// The research reader must be able to count a cross, not reject it as a pricing admission check would.
const QuoteSchema = Schema.Struct({
  ...archiveIdentity,
  bid_price: NonNegativeFiniteSchema,
  ask_price: NonNegativeFiniteSchema,
  bid_size: NonNegativeFiniteSchema,
  ask_size: NonNegativeFiniteSchema,
}).check(
  checkRoute('quotes'),
  Schema.makeFilter((row) => (row.bid_price > 0 || row.bid_size === 0) && (row.ask_price > 0 || row.ask_size === 0), {
    expected: 'zero size on withdrawn quote sides',
  }),
)

export const ShadowSessionSchema = Schema.Struct({
  date: IsoDateSchema,
  openAt: UtcSourceTimestampSchema,
  closeAt: UtcSourceTimestampSchema,
}).check(
  Schema.makeFilter(
    ({ date, openAt, closeAt }) => {
      const local = (timestamp: string) => {
        const instant = DateTime.make(timestamp)
        return Option.isSome(instant)
          ? DateTime.formatIsoZoned(DateTime.setZoneNamedUnsafe(instant.value, 'America/New_York')).slice(0, 19)
          : ''
      }
      return (
        intradayInstantNanos(openAt) % minuteNs === 0n &&
        intradayInstantNanos(closeAt) % minuteNs === 0n &&
        local(openAt) === `${date}T09:30:00` &&
        [`${date}T13:00:00`, `${date}T16:00:00`].includes(local(closeAt))
      )
    },
    { expected: 'a 09:30–13:00 or 09:30–16:00 New York RTH session on date' },
  ),
)
type ShadowSession = typeof ShadowSessionSchema.Type

const SnapshotSchema = Schema.Struct({
  session: ShadowSessionSchema,
  bars: Schema.Array(BarSchema).check(Schema.isMaxLength(maxBars)),
  quotes: Schema.Array(QuoteSchema).check(Schema.isMaxLength(maxQuotes)),
})
export const decodeShadowSnapshot = Schema.decodeUnknownResult(SnapshotSchema, strictParseOptions)
export const decodeBarLine = Schema.decodeUnknownResult(Schema.fromJsonString(BarSchema), strictParseOptions)
export const decodeQuoteLine = Schema.decodeUnknownResult(Schema.fromJsonString(QuoteSchema), strictParseOptions)
type ShadowSnapshot = typeof SnapshotSchema.Type
type Bar = typeof BarSchema.Type
type Quote = typeof QuoteSchema.Type

export class ShadowParityError extends Data.TaggedError('ShadowParityError')<{
  readonly message: string
  readonly cause?: string
}> {}

interface FinalBar {
  readonly close: number
  readonly ingest: bigint
  readonly event: bigint
  readonly partition: number
  readonly offset: bigint
  conflict: boolean
}

interface Samples {
  readonly bars: Map<number, FinalBar>
  readonly spreads: number[]
  readonly quoteLatencies: number[]
  crossed: number
  locked: number
  stale: number
  oneSided: number
}

const emptySamples = (): Samples => ({
  bars: new Map(),
  spreads: [],
  quoteLatencies: [],
  crossed: 0,
  locked: 0,
  stale: 0,
  oneSided: 0,
})
const pools = <T>(make: () => T) => ({ [Iex]: make(), [Sip]: make() })

const numericOrder = (a: number, b: number) => a - b
const midpoint = (left: number, right: number) => left + (right - left) / 2
const percentile = (sorted: readonly number[], fraction: number) =>
  sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
const summarize = (values: number[]) => {
  values.sort(numericOrder)
  const left = percentile(values, 0.5)
  const right = values[Math.floor(values.length / 2)]
  return {
    count: values.length,
    median: left === null || right === undefined ? null : midpoint(left, right),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
  }
}
const poolNumbers = (groups: readonly number[][]): number[] => {
  if (groups.length === 1) return groups[0] ?? []
  // Avoid growing a second overallocated buffer when pooling a full session of quotes.
  const all: number[] = []
  all.length = groups.reduce((count, group) => count + group.length, 0)
  let index = 0
  for (const group of groups) for (const value of group) all[index++] = value
  return all
}
const asMs = (nanos: bigint) => Number(nanos) / 1_000_000
const deltaBps = (old: number | null, next: number | null) => (old === null || next === null ? null : old - next)

const summarizeFeed = (samples: readonly Samples[], expected: number) => {
  const total = (read: (sample: Samples) => number) => samples.reduce((sum, sample) => sum + read(sample), 0)
  const barCount = total((sample) => sample.bars.size)
  const quoteCount = total((sample) => sample.quoteLatencies.length)
  const staleQuotes = total((sample) => sample.stale)
  const barLatencies = samples.flatMap((sample) =>
    Array.from(sample.bars.values(), (bar) => asMs(bar.ingest - bar.event)),
  )
  return {
    expectedBars: expected,
    barCount,
    barCoverage: barCount / expected,
    quoteCount,
    spreadBps: summarize(poolNumbers(samples.map((s) => s.spreads))),
    crossedQuotes: total((sample) => sample.crossed),
    lockedQuotes: total((sample) => sample.locked),
    oneSidedQuotes: total((sample) => sample.oneSided),
    staleQuotes,
    staleQuoteRate: quoteCount === 0 ? null : staleQuotes / quoteCount,
    barIngestLatencyMs: summarize(barLatencies),
    quoteIngestLatencyMs: summarize(poolNumbers(samples.map((s) => s.quoteLatencies))),
  }
}
interface SymbolReport {
  readonly symbol: SipSymbol
  readonly iex: ReturnType<typeof summarizeFeed>
  readonly sip: ReturnType<typeof summarizeFeed>
  readonly medianSpreadCompressionBps: number | null
  readonly barCloseDivergenceBps: ReturnType<typeof summarize>
}

const compareRevision = (next: FinalBar, prior: FinalBar) =>
  next.ingest !== prior.ingest
    ? next.ingest > prior.ingest
      ? 1
      : -1
    : next.partition !== prior.partition
      ? next.partition - prior.partition
      : next.offset === prior.offset
        ? 0
        : next.offset > prior.offset
          ? 1
          : -1

const gate = (id: string, pass: boolean, criterion: string, actual: string | number | null) => ({
  id,
  pass,
  criterion,
  actual,
})

/** One session-local accumulator shared by in-memory replay and the streaming archive reader. */
export const makeShadowComparison = (session: ShadowSession) => {
  const open = intradayInstantNanos(session.openAt)
  const close = intradayInstantNanos(session.closeAt)
  const expectedMinutes = Number((close - open) / minuteNs)
  const series = new Map(sipUniverse.all73.map((symbol) => [symbol, pools(emptySamples)]))
  const sipSymbols = new Set<string>()
  let mismatchedSipRows = 0
  const observe = (row: ArchiveIdentity) => {
    if (row.feed === Sip) {
      sipSymbols.add(row.symbol)
      if (row.universe_id !== sipUniverse.id || row.universe_symbol_hash !== sipUniverse.symbolHash) mismatchedSipRows++
    }
    return isSipCollectedSymbol(row.symbol) ? series.get(row.symbol)?.[row.feed] : undefined
  }
  const addBar = (row: Bar) => {
    const event = intradayInstantNanos(row.event_at)
    if (event < open || event >= close) return
    const sample = observe(row)
    if (sample === undefined || row.is_final === 0) return
    const ingest = intradayInstantNanos(row.ingested_at)
    const slot = Number((event - open) / minuteNs)
    const next = {
      close: row.close,
      event,
      ingest,
      partition: row.source_partition,
      offset: BigInt(row.source_offset),
      conflict: false,
    }
    const prior = sample.bars.get(slot)
    const order = prior === undefined ? 1 : compareRevision(next, prior)
    if (order === 0 && prior !== undefined && (next.close !== prior.close || next.event !== prior.event))
      prior.conflict = true
    if (order > 0) sample.bars.set(slot, next)
  }
  const addQuote = (row: Quote) => {
    const event = intradayInstantNanos(row.event_at)
    if (event < open || event >= close) return
    const sample = observe(row)
    if (sample === undefined) return
    const latencyNs = intradayInstantNanos(row.ingested_at) - event
    sample.quoteLatencies.push(asMs(latencyNs))
    if (latencyNs > staleNs) sample.stale++
    if (row.bid_price > row.ask_price && row.ask_price > 0) {
      sample.crossed++
      return
    }
    if (row.bid_price === 0 || row.ask_price === 0 || row.bid_size === 0 || row.ask_size === 0) {
      sample.oneSided++
      return
    }
    if (row.bid_price === row.ask_price) sample.locked++
    const spread = ((row.ask_price - row.bid_price) / midpoint(row.bid_price, row.ask_price)) * 10_000
    // Round away Float64 cancellation noise at the inclusive 2 bp boundary.
    sample.spreads.push(Math.round(spread * 1e9) / 1e9)
  }
  const finish = () =>
    Result.gen(function* () {
      const allDivergences: number[] = []
      const bySymbol: SymbolReport[] = []
      for (const [symbol, sample] of series) {
        const divergences: number[] = []
        for (const feed of [Iex, Sip]) {
          for (const [slot, bar] of sample[feed].bars) {
            if (bar.conflict)
              return yield* Result.fail(
                new ShadowParityError({ message: `Conflicting ${feed} bar revision for ${symbol} at minute ${slot}` }),
              )
          }
        }
        for (const [slot, bar] of sample[Sip].bars) {
          const iexBar = sample[Iex].bars.get(slot)
          if (iexBar === undefined) continue
          const divergence = (Math.abs(bar.close - iexBar.close) / iexBar.close) * 10_000
          if (!Number.isFinite(divergence))
            return yield* Result.fail(
              new ShadowParityError({ message: `Invalid close divergence for ${symbol} at minute ${slot}` }),
            )
          divergences.push(divergence)
        }
        for (const divergence of divergences) allDivergences.push(divergence)
        const iex = summarizeFeed([sample[Iex]], expectedMinutes)
        const sip = summarizeFeed([sample[Sip]], expectedMinutes)
        bySymbol.push({
          symbol,
          iex,
          sip,
          medianSpreadCompressionBps: deltaBps(iex.spreadBps.median, sip.spreadBps.median),
          barCloseDivergenceBps: summarize(divergences),
        })
      }
      const observed = [...sipSymbols].sort()
      const observedHash = sha256(observed.join(','))
      const missing = sipUniverse.all73.filter((symbol) => !sipSymbols.has(symbol))
      const unexpected = observed.filter((symbol) => !isSipCollectedSymbol(symbol))
      const samples = [...series.values()]
      const expectedBars = expectedMinutes * series.size
      const iex = summarizeFeed(
        samples.map((sample) => sample[Iex]),
        expectedBars,
      )
      const sip = summarizeFeed(
        samples.map((sample) => sample[Sip]),
        expectedBars,
      )
      const common = samples.filter((sample) => sample[Iex].spreads.length > 0 && sample[Sip].spreads.length > 0)
      const matchedIexSpread = summarize(poolNumbers(common.map((sample) => sample[Iex].spreads)))
      const matchedSipSpread = summarize(poolNumbers(common.map((sample) => sample[Sip].spreads)))
      const checks = [
        gate(
          'sip-universe',
          observedHash === sipUniverse.symbolHash && mismatchedSipRows === 0,
          'Exact 73-symbol roster and canonical ID/hash on every RTH SIP row',
          observedHash,
        ),
        ...coverageSymbols.map((symbol) => {
          const coverage = bySymbol.find((row) => row.symbol === symbol)?.sip.barCoverage ?? 0
          return gate(`sip-bar-coverage:${symbol}`, coverage >= completeRatio, 'SIP bar completeness ≥ 99.5%', coverage)
        }),
        gate('sip-crossed-quotes', sip.crossedQuotes === 0, 'Zero crossed SIP quotes', sip.crossedQuotes),
        gate(
          'sip-quote-ingest-latency',
          sip.quoteIngestLatencyMs.p95 !== null && sip.quoteIngestLatencyMs.p95 < maxQuoteLatencyMs,
          'Pooled SIP quote ingest p95 < 2,000 ms',
          sip.quoteIngestLatencyMs.p95,
        ),
        ...spreadSymbols.map((symbol) => {
          const median = bySymbol.find((row) => row.symbol === symbol)?.sip.spreadBps.median ?? null
          return gate(
            `sip-median-spread:${symbol}`,
            median !== null && median <= maxMedianSpreadBps,
            'Median SIP spread ≤ 2.0 bp',
            median,
          )
        }),
      ]
      return {
        schemaVersion: 'bayn.sip-shadow-parity-report.v1',
        session,
        expectedMinutes,
        universe: {
          id: sipUniverse.id,
          expectedHash: sipUniverse.symbolHash,
          observedHash,
          observedCount: observed.length,
          missing,
          unexpected,
          mismatchedSipRows,
        },
        gate: { pass: checks.every((check) => check.pass), checks },
        pooled: { iex, sip, barCloseDivergenceBps: summarize(allDivergences) },
        commonSymbolSpreads: {
          symbols: bySymbol.filter((row) => row.medianSpreadCompressionBps !== null).map((row) => row.symbol),
          iex: matchedIexSpread,
          sip: matchedSipSpread,
          medianSpreadCompressionBps: deltaBps(matchedIexSpread.median, matchedSipSpread.median),
        },
        bySymbol,
      }
    })
  return { addBar, addQuote, finish }
}

export type ShadowParityReport = Result.Result.Success<ReturnType<ReturnType<typeof makeShadowComparison>['finish']>>

export const compareShadowSnapshot = (
  snapshot: ShadowSnapshot,
): Result.Result<ShadowParityReport, ShadowParityError> => {
  const comparison = makeShadowComparison(snapshot.session)
  for (const row of snapshot.bars) comparison.addBar(row)
  for (const row of snapshot.quotes) comparison.addQuote(row)
  return comparison.finish()
}

export enum ReportFormat {
  Markdown = 'markdown',
  Json = 'json',
}
export const ReportFormatSchema = Schema.Enum(ReportFormat)

export const renderShadowReport = (report: ShadowParityReport, format: ReportFormat): string => {
  if (format === ReportFormat.Json) return JSON.stringify(report, null, 2)
  const number = (value: number | null) => (value === null ? '—' : value.toFixed(3))
  const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(2)}%`)
  const quantiles = (value: ReturnType<typeof summarize>) =>
    [value.median, value.p75, value.p95].map(number).join(' / ')
  const latency = (value: ReturnType<typeof summarize>) => [value.median, value.p95].map(number).join(' / ')
  const feedLine = (cohort: string, feed: EquityCutFeed, row: ReturnType<typeof summarizeFeed>) =>
    `| ${cohort} | ${feed} | ${row.barCount}/${row.expectedBars} (${percent(row.barCoverage)}) | ${row.quoteCount} | ${quantiles(row.spreadBps)} | ${row.crossedQuotes}/${row.lockedQuotes} | ${percent(row.staleQuoteRate)} | ${latency(row.quoteIngestLatencyMs)} | ${latency(row.barIngestLatencyMs)} |`
  return [
    `# SIP vs IEX shadow parity — ${report.session.date}`,
    '',
    `**${report.gate.pass ? 'PASS' : 'FAIL'}** · ${report.expectedMinutes} RTH minutes (${report.session.openAt} → ${report.session.closeAt}) · ${report.schemaVersion}`,
    '',
    `Universe: ${report.universe.observedCount}/${sipUniverse.all73.length} SIP symbols; ${report.universe.mismatchedSipRows} mismatched SIP rows.`,
    `Expected hash: \`${report.universe.expectedHash}\`; observed: \`${report.universe.observedHash}\`.`,
    ...(report.universe.missing.length > 0 ? [`Missing: ${report.universe.missing.join(', ')}.`] : []),
    ...(report.universe.unexpected.length > 0 ? [`Unexpected: ${report.universe.unexpected.join(', ')}.`] : []),
    '',
    ...report.gate.checks.map(
      (check) =>
        `- **${check.pass ? 'PASS' : 'FAIL'}** \`${check.id}\`: ${check.criterion} (observed ${check.actual ?? 'no evidence'}).`,
    ),
    '',
    '| Cohort | Feed | RTH bars | Quote rows | Spread bp (med / p75 / p95) | Crossed / locked | Stale >5s | Quote ingest ms (med / p95) | Bar ingest ms (med / p95) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...coverageSymbols.flatMap((symbol: SipSymbol) => {
      const row = report.bySymbol.find((entry) => entry.symbol === symbol)
      return row === undefined ? [] : [feedLine(symbol, Iex, row.iex), feedLine(symbol, Sip, row.sip)]
    }),
    feedLine('All 73', Iex, report.pooled.iex),
    feedLine('All 73', Sip, report.pooled.sip),
    '',
    `Common-symbol pooled spread (IEX → SIP, ${report.commonSymbolSpreads.symbols.length} symbols): ${quantiles(report.commonSymbolSpreads.iex)} → ${quantiles(report.commonSymbolSpreads.sip)} bp. Median compression: ${number(report.commonSymbolSpreads.medianSpreadCompressionBps)} bp.`,
    '',
    `Matched-minute close divergence (median / p75 / p95, bp): ${report.pooled.barCloseDivergenceBps.count} pooled pairs, ${quantiles(report.pooled.barCloseDivergenceBps)}.`,
    ...report.bySymbol
      .filter((row) => coverageSymbols.some((symbol) => symbol === row.symbol))
      .map(
        (row) =>
          `- ${row.symbol}: ${row.barCloseDivergenceBps.count} pairs, ${quantiles(row.barCloseDivergenceBps)}; median spread compression: ${number(row.medianSpreadCompressionBps)} bp.`,
      ),
    '',
    'Missing observations are shown as —. Full per-symbol detail is in JSON. This report grants no trading authority.',
  ].join('\n')
}
