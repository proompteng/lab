import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'

import { etfs as canaryEtfs, mix, splits } from './etf-canary-macro-protocol'
import { marks, replay as canaryReplay } from './etf-canary-macro-replay'
import { features, targets } from './etf-canary-macro-signals'
import { etfs as premiaEtfs, frozenArms } from './multi-asset-risk-premia-protocol'
import { blend, investedReturn, netReturn, replay as premiaReplay } from './multi-asset-risk-premia-replay'
import { makeFeatures, signalBook } from './multi-asset-risk-premia-signals'
import {
  carries,
  costs,
  initialEquity,
  mixes,
  modes,
  replayAccount,
  type LedgerRow,
  type Mode,
} from './pure-etf-dual-horizon-account'
import { elapsedDays, etfs, loadData, receipts, sha256, type DailyFrame } from './pure-etf-dual-horizon-data'
import { bindExitSupplement, executionSupplement, noiseOrders } from './pure-etf-dual-horizon-noise'
import {
  attribution,
  bootstrapProtocol,
  bootstrapRisk,
  correlations,
  spyDrawdownIndices,
  stationaryBlocks,
  summarize,
} from './pure-etf-dual-horizon-statistics'

const sourceRevisions = {
  O1: '06e85b0e59f70c8b09181266a883179c8c90b498',
  O2: '1731c7ede32f22306aaf55e101fc8354978b0445',
  I1: '73b26d5ad6875064fe4df4dcdc5bf1a844949112',
} as const

type Window = { first: number; end: number; from: string; through: string; sessions: number }
const bounds = (dates: readonly string[]): Record<string, Window> & { full: Window; blind: Window } => {
  const window = (first: number, end: number) => ({
    first,
    end,
    from: dates[first],
    through: dates[end - 1],
    sessions: end - first,
  })
  const find = (from: string, through: string) => window(dates.indexOf(from), dates.indexOf(through) + 1)
  return {
    full: window(0, dates.length),
    blind: find('2016-01-04', '2023-12-29'),
    ...Object.fromEntries(
      Object.entries(splits).map(([id, [from, through, sessions]]) => {
        const w = find(from, through)
        if (w.sessions !== sessions) throw new Error(`Wrong session count for ${id}`)
        return [id, w]
      }),
    ),
    ...Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => {
        const year = String(2016 + i)
        return [
          year,
          window(
            dates.findIndex((d) => d.startsWith(year)),
            dates.findLastIndex((d) => d.startsWith(year)) + 1,
          ),
        ]
      }),
    ),
  }
}

const benchmarks = (daily: readonly DailyFrame[], symbol: string) =>
  daily.map((frame, i) => {
    const current = frame.bars.get(symbol)
    const previous = i === 0 ? current?.open : daily[i - 1].bars.get(symbol)?.close
    if (current === undefined || previous === undefined) throw new Error(`Missing benchmark: ${symbol} ${frame.date}`)
    return current.close / previous - 1
  })
const sum = (rows: readonly number[]) => rows.reduce((total, v) => total + v, 0)
const closeTo = (observed: number, frozen: number, tolerance: number, label: string) => {
  if (!Number.isFinite(observed) || Math.abs(observed - frozen) >= tolerance)
    throw new Error(`Frozen ${label} mismatch: ${observed} vs ${frozen}`)
}

class StudyError extends Data.TaggedError('PureEtfStudyError')<{ cause: unknown }> {}
const run = async (directory: string, output: string, ledgerDirectory: string | undefined, signal: AbortSignal) => {
  const { daily, intraday, coverage } = await loadData(directory, signal)
  const dates = daily.map(({ date }) => date)
  const windows = bounds(dates)
  const canary = daily.map(({ date, bars }) => ({
    date,
    open: Float64Array.from(canaryEtfs, (symbol) => bars.get(symbol)?.open ?? NaN),
    close: Float64Array.from(canaryEtfs, (symbol) => bars.get(symbol)?.close ?? NaN),
  }))
  const premia = daily.map(({ date, bars }) => ({ date, bars: premiaEtfs.map((symbol) => bars.get(symbol)) }))
  const targetFeatures = makeFeatures(premia, ['2026-11-27', '2026-11-30'])
  const target = {
    O1: targets(mix, features(canary), -1),
    O2: blend(
      frozenArms.map((arm) => signalBook(targetFeatures, arm)),
      premia,
    ),
  }
  const prepared = noiseOrders(intraday)
  const noise = prepared.map(({ orders }, i) => bindExitSupplement(intraday[i], orders))
  const SPY = benchmarks(daily, 'SPY')
  const SHY = benchmarks(daily, 'SHY')
  const IEF = benchmarks(daily, 'IEF')
  const GLD = benchmarks(daily, 'GLD')
  const blocks = stationaryBlocks(daily.length)
  const report = (net: readonly number[], mode: Mode, ledger?: readonly LedgerRow[]) => ({
    byWindow: Object.fromEntries(
      Object.entries(windows).map(([name, { first, end }]) => {
        const sub = <T>(series: readonly T[]) => series.slice(first, end)
        return [
          name,
          {
            ...summarize(sub(dates), sub(net), sub(SHY), sub(SPY), mode),
            ...(ledger === undefined ? {} : { attributionUsd: attribution(sub(ledger)) }),
          },
        ]
      }),
    ),
    bootstrap: bootstrapRisk(net, SHY, mode, blocks),
  })
  if (ledgerDirectory !== undefined) await mkdir(ledgerDirectory, { recursive: true })
  const recordLedger = async (name: string, rows: readonly LedgerRow[]) => {
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    if (ledgerDirectory !== undefined) await writeFile(join(ledgerDirectory, `${name}.ndjson`), body, { signal })
    return {
      sha256: sha256(body),
      maxOpenGross: Math.max(...rows.map((r) => r.openGross)),
      maxCloseGross: Math.max(...rows.map((r) => r.closeGross)),
      maxCombinedReserved: Math.max(...rows.map((r) => r.openGross + r.intradayPeak)),
      maxIntradayReserved: Math.max(...rows.map((r) => r.intradayPeak)),
      minDtbp: Math.min(...rows.map((r) => r.dtbp)),
      daysOvernightTrimmed: rows.filter((r) => r.overnightTrim).length,
      conflicts: sum(rows.map((r) => r.conflicts)),
      intradayTrims: sum(rows.map((r) => r.intradayTrims)),
      missingIntradayEntries: sum(rows.map((r) => r.missingEntries)),
      intradayHeldGaps: sum(rows.flatMap((r) => r.trades.map((leg) => leg.heldGaps))),
      trades: sum(rows.map((r) => r.trades.length)),
      executionSupplementFills: rows.flatMap((row) =>
        row.trades.filter((t) => t.exitSource !== undefined).map((t) => ({ date: row.date, ...t })),
      ),
      annualOvernightOneWayTurnoverOnInitialEquity:
        (sum(rows.map((r) => r.overnightTurnover)) * 252) / (2 * initialEquity * rows.length),
    }
  }

  const independent: Record<string, readonly number[]> = {}
  const standalone = []
  // Replay upstream conventions before harmonizing the books. These are not mixed-dollar overlays.
  const originalMarks = marks(canary)
  const o1Paper = ([2, 5, 10] as const).map((bp, index) => {
    const path = canaryReplay(originalMarks, target.O1, bp, true)
    const net = Array.from(path.net)
    const result = summarize(dates, net, SHY, SPY, 'compound')
    closeTo(result.netReturn, [0.9442965714, 0.9286692789, 0.9029113849][index], 1e-9, `O1 full ${bp} bp`)
    return {
      bp,
      ...result,
      splits: Object.fromEntries(
        Object.keys(splits).map((id) => {
          const { first, end } = windows[id]
          return [
            id,
            {
              ...summarize(
                dates.slice(first, end),
                net.slice(first, end),
                SHY.slice(first, end),
                SPY.slice(first, end),
                'compound',
              ),
              annualOneWayTurnover: (sum(Array.from(path.turnover.slice(first, end))) * 252) / (end - first),
            },
          ]
        }),
      ),
    }
  })
  const originalO2Splits = Object.entries(splits).map(([id, [from, through]]) => {
    const w = dates.indexOf(from)
    const rows = premiaReplay(premia, target.O2, w, dates.indexOf(through))
    return {
      id,
      withShy: sum(rows.map((row) => investedReturn(row, 10))) * initialEquity,
      withoutShy: sum(rows.map((row) => netReturn(row, 10))) * initialEquity,
    }
  })
  closeTo(
    sum(originalO2Splits.map((w) => w.withShy)),
    45_434.75327182199,
    0.00001,
    'O2 split-stitched 10 bp with sweep',
  )
  const standaloneMixes = {
    O1: mixes.M1,
    O2: { O1: 0, O2: 1, intraday: 0 },
    I1: mixes.M2,
    I2: mixes.M3,
  }
  for (const [id, allocation] of Object.entries(standaloneMixes)) {
    // Matched close-to-close isolated returns at 2 bp, no cash yield in either intraday series.
    const mode = id === 'O1' ? 'compound' : 'fixed'
    const rows = replayAccount(daily, noise, target, {
      mix: allocation,
      mode,
      carry: id === 'O1' || id === 'O2' ? 'SHY' : 'zero',
      bp: 2,
    })
    const net = rows.map((row) => row.return)
    independent[id] = net
    if (id === 'I1') {
      closeTo(sum(net.slice(0, windows.blind.end)) * initialEquity, 41_848.66, 0.005, 'I1 blind 2 bp')
      closeTo(sum(net) * initialEquity, 67_164.47, 0.005, 'I1 full 2 bp')
    }
    standalone.push({ id, mode, ledger: await recordLedger(id, rows), ...report(net, mode) })
  }

  const portfolios = []
  for (const [id, allocation] of Object.entries(mixes)) {
    for (const mode of modes)
      for (const carry of carries)
        for (const bp of costs) {
          signal.throwIfAborted()
          const rows = replayAccount(daily, noise, target, { mix: allocation, mode, carry, bp })
          const net = rows.map((row) => row.return)
          portfolios.push({
            id,
            mode,
            carry,
            bp,
            ledger: await recordLedger(`${id}-${mode}-${carry}-${bp}bp`, rows),
            ...report(net, mode, rows),
          })
        }
  }
  const common = { ...independent, SPY, IEF, GLD, SHY }
  const result = {
    schema: 'bayn.wave6c.pure-etf-dual-horizon.v1',
    inputs: receipts,
    sourceRevisions,
    executionSupplement,
    coverage,
    universe: etfs,
    initialEquity,
    windows,
    elapsedYears: (elapsedDays(dates[0], dates[dates.length - 1]) + 1) / 365.2425,
    mixes,
    bootstrapProtocol,
    quality: {
      o1OriginalCompounded: o1Paper,
      o2OriginalSplitStitchedAt10BpUsd: originalO2Splits,
      noiseCoverage: {
        readyEtfSessions: sum(prepared.map(({ ready }) => ready.length)),
        incompleteEtfSessions: prepared.flatMap(({ incomplete }, i) =>
          incomplete.length === 0 ? [] : [{ date: dates[i], incomplete }],
        ),
      },
    },
    correlation: {
      full: correlations(
        common,
        dates.map((_, i) => i),
      ),
      spyDrawdown: correlations(common, spyDrawdownIndices(SPY)),
    },
    standalone,
    benchmarks: modes.flatMap((mode) =>
      Object.entries({ SHY, '60/40': SPY.map((v, i) => 0.6 * v + 0.4 * IEF[i]), SPY }).map(([id, net]) => ({
        id,
        mode,
        ...report(net, mode),
      })),
    ),
    portfolios,
  }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { signal })
}

if (import.meta.main) {
  const program = Effect.tryPromise({
    try: (signal) => {
      const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: { 'data-dir': { type: 'string' }, output: { type: 'string' }, 'ledger-dir': { type: 'string' } },
      })
      if (
        values['data-dir'] === undefined ||
        values['data-dir'] === '' ||
        values.output === undefined ||
        values.output === ''
      )
        throw new Error(
          'Usage: bun research-10yr-pure-etf-dual-horizon.ts --data-dir <dir> --output <results.json> [--ledger-dir <dir>]',
        )
      return run(values['data-dir'], values.output, values['ledger-dir'], signal)
    },
    catch: (cause) => new StudyError({ cause }),
  })
  NodeRuntime.runMain(program)
}
