import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Result } from 'effect'

import { canonicalHashV1Result, sha256 } from '../../src/hash'
import { decodeMacroEtfCorePolicy, Profile } from '../../src/strategy/macro-etf-core/policy'
import { closeSnapshotSchema, replayMacroEtfCoreSignals } from '../../src/strategy/macro-etf-core/signals'
import { bootstrap } from '../vol-regime-carry-metrics'
import { costs, initialUsd, mixes, noiseIdentity, replayAccount, toMarks } from './macro-etf-core-dual-horizon-account'
import { receipts } from '../pure-etf-dual-horizon-data'
import { noiseOrders } from '../pure-etf-dual-horizon-noise'
import { type DailyFrame, loadFrozenFrames } from './macro-etf-core-dual-horizon-data'
import { type Day, drawdownDays, pairedCorrelation, summarize } from './macro-etf-core-dual-horizon-statistics'
import { wave5dTargets } from './macro-etf-core-wave5d'

const frozen = {
  F2: { count: 63, sha256: '7e297125e3acaca974bd2d9fcafbc9bed88181661f780cadb2fd310003662a04' },
  F4: { count: 63, sha256: '384ae7f5f241cb95fa5dc8d2c61a72a5a34048f4fdf96497ed84ec0d17168ed6' },
  O1: { count: 119, sha256: '690bbb6193b4dd9659eec0a3c56c553b23816dd916d2e49c4bc0460249ddef5c' },
} as const
const revisions = {
  wave5c: '4899b0547f1e5fc8a8dd9a8bd60ec768cbd2b229',
  wave5d: '06e85b0e59f70c8b09181266a883179c8c90b498',
  wave6c: 'f55167fe6a13419d1fe4c15b1df23e7a619dd569',
  noiseC5: '73b26d5ad6875064fe4df4dcdc5bf1a844949112',
} as const
const windows = {
  full: ['2016-01-04', '2026-11-25', 2741],
  train: ['2016-01-04', '2021-12-31', 1511],
  validation: ['2022-01-03', '2023-12-29', 501],
  holdout: ['2024-01-02', '2026-11-25', 729],
  blind2016To2023: ['2016-01-04', '2023-12-29', 2012],
  recent2024To2026: ['2024-01-02', '2026-11-25', 729],
  bear2022: ['2022-01-03', '2022-12-30', 251],
} as const
const pack = (weights: readonly number[]) => weights.map((w) => w.toFixed(12))
const requireOracle = (name: keyof typeof frozen, rows: readonly unknown[]) => {
  const digest = sha256(JSON.stringify(rows))
  if (digest !== frozen[name].sha256 || rows.length !== frozen[name].count)
    throw new Error(`Frozen ${name} replay mismatch: ${rows.length} reviews / ${digest}`)
  return digest
}

const closeEvidence = (daily: readonly DailyFrame[]) => {
  const calendar = daily.map(({ date, openAt, closeAt }) => ({ date, openAt, closeAt }))
  const bars = daily
    .slice(0, -1)
    .map(({ date, closeAt, bars }) =>
      [...bars].map(([symbol, bar]) => ({ date, symbol, availableAt: closeAt, ...bar })),
    )
  const snapshot = {
    schema: closeSnapshotSchema,
    datasetVersion: 'alpacav2-sip-10yr-sp100-with-dia-uup-2026-11-27',
    adjustment: 'all',
    calendar,
    bars,
  }
  return {
    asOf: daily[daily.length - 1].openAt,
    snapshot,
    snapshotHash: Result.getOrThrow(canonicalHashV1Result(snapshot)),
  }
}

const prepareMacro = (evidence: ReturnType<typeof closeEvidence>, profile: Profile) => {
  const input = { schema: 'bayn.macro-etf-core-policy.v1', profile }
  const policy = Result.getOrThrow(decodeMacroEtfCorePolicy(input))
  const signals = Result.getOrThrow(replayMacroEtfCoreSignals(input, evidence))
  const digest = requireOracle(
    profile,
    signals.map(({ signalDate, executionDate, weights }) => [signalDate, executionDate, pack(weights)]),
  )
  return {
    weights: new Map(signals.map(({ executionDate, weights }) => [executionDate, weights])),
    receipt: { ...frozen[profile], sha256: digest, policyHash: policy.hash, trial: policy.settings.trial },
  }
}

const benchmarks = (daily: readonly DailyFrame[], symbol: 'SPY' | 'SHY'): Day[] =>
  daily.map(({ date, bars }, i) => {
    const bar = bars.get(symbol)
    const from = i === 0 ? bar?.open : daily[i - 1].bars.get(symbol)?.close
    if (bar === undefined || from === undefined) throw new Error(`Missing benchmark: ${symbol} ${date}`)
    const net = bar.close / from - 1
    const turnover = i === 0 ? 0.5 : 0
    return { date, net, overnight: net, intraday: 0, oneWayTurnover: turnover, overnightOneWayTurnover: turnover }
  })

const sum = (series: readonly number[]) => series.reduce((a, b) => a + b, 0)
const near = (actual: number, expect: number, label: string) => {
  if (!(Math.abs(actual - expect) < 0.005)) throw new Error(`Frozen ${label} mismatch: ${actual} vs ${expect}`)
}

const study = ({ daily, intraday, coverage }: Effect.Success<typeof loadFrozenFrames>) => {
  const evidence = closeEvidence(daily)
  const f2 = prepareMacro(evidence, Profile.F2)
  const f4 = prepareMacro(evidence, Profile.F4)
  const O1 = wave5dTargets(daily)
  const o1Digest = requireOracle(
    'O1',
    O1.slice(0, -1).flatMap((weights, i) => (weights === undefined ? [] : [[daily[i].date, pack(weights)]])),
  )
  const prepared = noiseOrders(intraday)
  const noise = prepared.map(({ orders }) => orders)
  const c5 = noiseIdentity(daily, noise)
  const blindPnl = sum(c5.slice(0, windows.blind2016To2023[2]))
  const fullPnl = sum(c5)
  near(blindPnl, 41_848.66, 'C5 blind 2 bp round trip')
  near(fullPnl, 67_164.47, 'C5 full 2 bp round trip')

  const B0 = benchmarks(daily, 'SHY')
  const B1 = benchmarks(daily, 'SPY')
  const drawdown = drawdownDays(B1.map(({ net }) => net))
  const report = (rows: readonly Day[]) =>
    Object.fromEntries(
      Object.entries(windows).map(([id, [from, through, count]]) => {
        const first = daily.findIndex(({ date }) => date === from)
        const end = daily.findIndex(({ date }) => date === through) + 1
        if (first < 0 || end - first !== count) throw new Error(`Frozen split mismatch: ${id}`)
        return [
          id,
          summarize(
            rows.slice(first, end),
            B0.slice(first, end).map(({ net }) => net),
            drawdown.slice(first, end),
          ),
        ]
      }),
    )

  const marks = toMarks(daily)
  const target = { F2: f2.weights, F4: f4.weights, O1 }
  const passive = { B0: { byWindow: report(B0) }, B1: { byWindow: report(B1) } }
  const portfolios = costs.map((oneWayBps) => {
    const ledgers = Object.fromEntries(
      Object.entries(mixes).map(([id, mix]) => [id, replayAccount(marks, noise, target, mix, oneWayBps)]),
    )
    const results = Object.fromEntries(
      Object.entries(ledgers).map(([id, rows]) => [
        id,
        {
          byWindow: report(rows),
          ledger: {
            sha256: sha256(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
            endingEquityUsd: rows[rows.length - 1].equity,
            maxOpenGrossUsd: Math.max(...rows.map((r) => r.openGross)),
            maxCloseGrossUsd: Math.max(...rows.map((r) => r.closeGross)),
            maxCombinedReservedUsd: Math.max(...rows.map((r) => r.openGross + r.reserved)),
            maxIntradayReservedUsd: Math.max(...rows.map((r) => r.reserved)),
            minimumDtbpUsd: Math.min(...rows.map((r) => r.dtbp)),
            overnightTrimDays: rows.filter((r) => r.overnightTrim).length,
            totalOvernightTradedUsd: sum(rows.map((r) => r.overnightTraded)),
            totalIntradayTradedUsd: sum(rows.map((r) => r.intradayTraded)),
            financingUsd: sum(rows.map((r) => r.financing)),
            overnightCostsUsd: sum(rows.map((r) => r.overnightCosts)),
            noiseConflicts: sum(rows.map((r) => r.conflicts)),
            capacityTrims: sum(rows.map((r) => r.capacityTrims)),
            noiseFills: sum(rows.map((r) => r.fills)),
            missingNoiseEntries: sum(rows.map((r) => r.missingEntries)),
            noiseHeldGaps: sum(rows.map((r) => r.heldGaps)),
          },
        },
      ]),
    )
    const unshared = ledgers['I1'].map((r) => r.intraday)
    return {
      oneWayBps,
      results: { ...passive, ...results },
      independentCorrelations: {
        F2VsNoise: pairedCorrelation(
          ledgers['E1'].map((r) => r.overnight),
          unshared,
          drawdown,
        ),
        F4VsNoise: pairedCorrelation(
          ledgers['E2'].map((r) => r.overnight),
          unshared,
          drawdown,
        ),
      },
    }
  })
  return {
    schema: 'bayn.macro-etf-core-dual-horizon.v1',
    revisions,
    initialEquityUsd: initialUsd,
    passiveBenchmarksAreFrictionless: true,
    archiveReceipts: receipts,
    archiveCoverage: coverage,
    closeSnapshotHash: evidence.snapshotHash,
    oracle: {
      F2: f2.receipt,
      F4: f4.receipt,
      O1: { ...frozen.O1, sha256: o1Digest },
      C5: { blindPnl, fullPnl, roundTripBps: 2 },
    },
    noiseCoverage: {
      QQQ: {
        incompleteSessions: prepared.filter((d) => d.incomplete.includes('QQQ')).length,
        readySessions: prepared.filter((d) => d.ready.includes('QQQ')).length,
      },
      SMH: {
        incompleteSessions: prepared.filter((d) => d.incomplete.includes('SMH')).length,
        readySessions: prepared.filter((d) => d.ready.includes('SMH')).length,
      },
    },
    allocations: mixes,
    bootstrap,
    portfolios,
  }
}

class ReplayError extends Data.TaggedError('MacroEtfCoreReplayError')<{ readonly cause: unknown }> {}

const main = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } }),
    catch: (cause) => new ReplayError({ cause }),
  })
  const output = args.values.output
  if (output === undefined || output === '')
    return yield* new ReplayError({ cause: 'Usage: bun macro-etf-core-dual-horizon.ts --output SUMMARY.json' })
  const frames = yield* loadFrozenFrames
  const summary = yield* Effect.try({ try: () => study(frames), catch: (cause) => new ReplayError({ cause }) })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(summary, null, 2) + '\n', { signal }),
    catch: (cause) => new ReplayError({ cause }),
  })
})

if (import.meta.main) NodeRuntime.runMain(main)
