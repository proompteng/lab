import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { sha256 } from '../../hash'
import { currentEquityUniverse } from '../../strategy/intraday-market'
import { checkProperty } from '../../testing/property-test-support'
import {
  isSipBenchmark,
  isSipCollectedSymbol,
  isSipEtfSleeveCandidate,
  isSipIntradayEquityCandidate,
  sipUniverse,
  verifySipUniverse,
} from './index'

const expectedEquity = (
  'AAPL,ALAB,AMAT,AMD,AMZN,ANET,APP,ARM,ASML,AVGO,CEG,COHR,COIN,CRDO,CRWD,GEV,GOOGL,HOOD,INTC,KLAC,LITE,LRCX,' +
  'META,MRVL,MSFT,MSTR,MU,NET,NFLX,NOW,NVDA,ORCL,PANW,PLTR,SHOP,SMCI,SNDK,SNOW,SOFI,SPOT,TSLA,TSM,UBER,VRT,VST,WDC'
).split(',')
const expectedEtfs =
  'DBC,EEM,EFA,GLD,HYG,IEF,IWM,LQD,QQQ,SHY,SLV,SMH,SPY,TLT,USO,VNQ,XLB,XLC,XLE,XLF,XLI,XLK,XLP,XLRE,XLU,XLV,XLY'.split(
    ',',
  )
const expectedHash = '89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b'

test('the frozen manifest binds the exact disjoint cohorts and retained IEX core under a new identity', () => {
  const { id, symbolHash, equity46, etf27, core22, benchmarks, all73 } = sipUniverse
  expect(id).toBe('torghut-core-equity-sip-v1')
  expect<readonly string[]>(equity46).toEqual(expectedEquity)
  expect<readonly string[]>(etf27).toEqual(expectedEtfs)
  expect(equity46).toHaveLength(46)
  expect(etf27).toHaveLength(27)
  expect(new Set(all73).size).toBe(73)
  expect<readonly string[]>(all73).toEqual([...expectedEquity, ...expectedEtfs].sort())
  expect(core22).toHaveLength(22)
  expect<readonly string[]>(core22).toEqual(currentEquityUniverse.symbols)
  expect(core22.every(isSipCollectedSymbol)).toBe(true)
  const core = new Set<string>(core22)
  expect(all73.filter((symbol) => !core.has(symbol))).toHaveLength(51)
  expect(benchmarks).toEqual(['SPY'])
  expect(symbolHash).toBe(expectedHash)
  expect(sha256(all73.join(','))).toBe(expectedHash)
  expect(Result.getOrThrow(verifySipUniverse(sipUniverse))).toEqual(sipUniverse)
  for (const item of [sipUniverse, equity46, etf27, core22, benchmarks, all73]) expect(Object.isFrozen(item)).toBe(true)
})

test('collection, stock candidacy, ETF sleeve membership, and benchmarking are separate roles', () => {
  for (const [symbol, collected, equity, etf, benchmark] of [
    ['AAPL', true, true, false, false],
    ['ALAB', true, true, false, false],
    ['GLD', true, false, true, false],
    ['SPY', true, false, true, true],
    ['aapl', false, false, false, false],
    ['BTC/USD', false, false, false, false],
    ['DIA', false, false, false, false],
  ] as const) {
    expect(isSipCollectedSymbol(symbol)).toBe(collected)
    expect(isSipIntradayEquityCandidate(symbol)).toBe(equity)
    expect(isSipEtfSleeveCandidate(symbol)).toBe(etf)
    expect(isSipBenchmark(symbol)).toBe(benchmark)
  }
})

test('the verifier rejects a different identity, hash, or role assignment', () => {
  for (const change of [
    { id: currentEquityUniverse.id },
    { symbolHash: currentEquityUniverse.symbolHash },
    { benchmarks: ['QQQ'] },
    { core22: sipUniverse.core22.slice(1) },
    { equity46: sipUniverse.equity46.map((symbol) => (symbol === 'AAPL' ? 'SPY' : symbol)) },
    { etf27: sipUniverse.etf27.map((symbol) => (symbol === 'SPY' ? 'AAPL' : symbol)) },
  ]) {
    expect(Result.isFailure(verifySipUniverse({ ...sipUniverse, ...change }))).toBe(true)
  }
})

test('property: replacing or reordering any symbol fails verification even with the canonical declared hash', () => {
  checkProperty(
    'sip-universe-identity',
    fc.property(fc.integer({ min: 0, max: 72 }), (index) => {
      const omitted = sipUniverse.all73.filter((_, i) => i !== index)
      const replaced = sipUniverse.all73.map((symbol, i) => (i === index ? 'DIA' : symbol))
      const duplicate = sipUniverse.all73.map((symbol, i) => (i === index ? sipUniverse.all73[(i + 1) % 73] : symbol))
      const rotated = [...sipUniverse.all73.slice(index + 1), ...sipUniverse.all73.slice(0, index + 1)]
      for (const all73 of [omitted, replaced, duplicate]) {
        expect(Result.isFailure(verifySipUniverse({ ...sipUniverse, all73 }))).toBe(true)
      }
      expect(Result.isSuccess(verifySipUniverse({ ...sipUniverse, all73: rotated }))).toBe(index === 72)
    }),
  )
})
