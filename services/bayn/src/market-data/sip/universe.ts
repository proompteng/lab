import { Result, Schema } from 'effect'

import { sha256 } from '../../hash'
import { strictParseOptions } from '../../schemas'

const equity46 = Object.freeze([
  'AAPL',
  'ALAB',
  'AMAT',
  'AMD',
  'AMZN',
  'ANET',
  'APP',
  'ARM',
  'ASML',
  'AVGO',
  'CEG',
  'COHR',
  'COIN',
  'CRDO',
  'CRWD',
  'GEV',
  'GOOGL',
  'HOOD',
  'INTC',
  'KLAC',
  'LITE',
  'LRCX',
  'META',
  'MRVL',
  'MSFT',
  'MSTR',
  'MU',
  'NET',
  'NFLX',
  'NOW',
  'NVDA',
  'ORCL',
  'PANW',
  'PLTR',
  'SHOP',
  'SMCI',
  'SNDK',
  'SNOW',
  'SOFI',
  'SPOT',
  'TSLA',
  'TSM',
  'UBER',
  'VRT',
  'VST',
  'WDC',
] as const)
const etf27 = Object.freeze([
  'DBC',
  'EEM',
  'EFA',
  'GLD',
  'HYG',
  'IEF',
  'IWM',
  'LQD',
  'QQQ',
  'SHY',
  'SLV',
  'SMH',
  'SPY',
  'TLT',
  'USO',
  'VNQ',
  'XLB',
  'XLC',
  'XLE',
  'XLF',
  'XLI',
  'XLK',
  'XLP',
  'XLRE',
  'XLU',
  'XLV',
  'XLY',
] as const)
// Freeze the v3 source cohort here: later changes to the live universe must not redefine the SIP identity.
const core22 = Object.freeze([
  'AAPL',
  'AMD',
  'AMZN',
  'AVGO',
  'COHR',
  'CRDO',
  'GOOGL',
  'INTC',
  'IWM',
  'LITE',
  'META',
  'MRVL',
  'MSFT',
  'MU',
  'NFLX',
  'NVDA',
  'QQQ',
  'SMH',
  'SNDK',
  'SPY',
  'TSLA',
  'WDC',
] as const)
const benchmarks = Object.freeze(['SPY'] as const)
const all73 = Object.freeze([...equity46, ...etf27].sort())
const id = 'torghut-core-equity-sip-v1'
const symbolHash = '89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b'

export const SipSymbolSchema = Schema.Literals(all73)
export type SipSymbol = typeof SipSymbolSchema.Type

const canonicalCohort = <const S extends readonly string[]>(symbols: S, count: number) =>
  Schema.Array(Schema.Literals(symbols)).check(
    Schema.isBetweenLength(count, count),
    Schema.isUnique(),
    Schema.makeFilter((input) => input.every((symbol, i) => symbol === symbols[i]), {
      expected: 'the canonical symbols in order',
    }),
  )

export const SipUniverseSchema = Schema.Struct({
  id: Schema.Literal(id),
  symbolHash: Schema.Literal(symbolHash),
  equity46: canonicalCohort(equity46, 46),
  etf27: canonicalCohort(etf27, 27),
  core22: canonicalCohort(core22, 22),
  benchmarks: canonicalCohort(benchmarks, 1),
  all73: canonicalCohort(all73, 73),
}).check(
  Schema.makeFilter(
    (manifest) => {
      const collected = new Set<string>(manifest.all73)
      return (
        manifest.core22.every((symbol) => collected.has(symbol)) &&
        manifest.benchmarks.every((symbol) => collected.has(symbol)) &&
        sha256(manifest.all73.join(',')) === manifest.symbolHash
      )
    },
    { expected: 'contained core and benchmark cohorts and the canonical sorted-symbol SHA-256' },
  ),
)

export const verifySipUniverse = Schema.decodeUnknownResult(SipUniverseSchema, strictParseOptions)

export const sipUniverse = Object.freeze({ id, symbolHash, equity46, etf27, core22, benchmarks, all73 })
Result.getOrThrow(verifySipUniverse(sipUniverse))

export const isSipCollectedSymbol = Schema.is(SipSymbolSchema)
/** Cohort membership only; it does not grant strategy or broker authority. */
export const isSipIntradayEquityCandidate = Schema.is(Schema.Literals(equity46))
/** SPY is both an ETF sleeve member and a benchmark, never an intraday equity candidate. */
export const isSipEtfSleeveCandidate = Schema.is(Schema.Literals(etf27))
export const isSipBenchmark = Schema.is(Schema.Literals(benchmarks))
