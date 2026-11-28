import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { ConfigProvider, Deferred, Effect, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../src/effect-test-support'
import { sha256 } from '../src/hash'
import { runPortfolioCommand } from './simulate-multi-sleeve-portfolio'
import {
  Account,
  Allocation,
  decodePortfolioEvidence,
  decodePortfolioScenario,
  defaultScenario,
  simulatePortfolio,
  Sleeve,
} from './simulate-multi-sleeve-portfolio-core'

const dates = [
  '2024-01-02',
  '2024-01-03',
  '2024-01-04',
  '2024-01-05',
  '2024-01-08',
  '2024-01-09',
  '2024-01-10',
  '2024-01-11',
  '2024-01-12',
  '2024-01-16',
] as const
const receipt = 'a'.repeat(64)
const schemaVersion = 'bayn.multi-sleeve-return-series.v1'

// Arithmetic probes only: historical runs require separately verified evidence, not these inputs.
type Row = readonly [b0: number, f4: number, o1: number, shy: number, dayTrades?: number]
const fixture = (rows: readonly Row[]) => ({
  schemaVersion,
  calendar: { sourceSha256: receipt, sessions: rows.map((_, i) => ({ date: dates[i] })) },
  sleeves: {
    B0: {
      sourceSha256: receipt,
      sessions: rows.map(([netReturn, , , , dayTradeCount = 1], i) => ({ date: dates[i], netReturn, dayTradeCount })),
    },
    F4: { sourceSha256: receipt, sessions: rows.map(([, netReturn], i) => ({ date: dates[i], netReturn })) },
    O1: { sourceSha256: receipt, sessions: rows.map(([, , netReturn], i) => ({ date: dates[i], netReturn })) },
    SHY: { sourceSha256: receipt, sessions: rows.map(([, , , netReturn], i) => ({ date: dates[i], netReturn })) },
  },
})
const scenario = { ...defaultScenario, lookbackSessions: 2 }
const simulate = (rows: readonly Row[], overrides: Partial<typeof scenario> = {}) =>
  Result.getOrThrow(
    simulatePortfolio(
      Result.getOrThrow(decodePortfolioEvidence(fixture(rows))),
      Result.getOrThrow(decodePortfolioScenario({ ...scenario, ...overrides })),
    ),
  )

type Report = ReturnType<typeof simulate>
const run = (report: Report, allocation: Allocation, bps = 0, account = Account.LiveMain) => {
  const selected = report.runs.find(
    (row) => row.account === account && row.allocation === allocation && row.rebalanceBps === bps,
  )
  if (selected === undefined) throw new Error('Expected scenario in report')
  return selected
}
const returnProbes: readonly Row[] = [
  [-0.02, -0.04, -0.08, 0],
  [0.02, 0.04, 0.08, 0.001],
  [0.1, -0.05, 0.02, 0.001],
  [-0.1, 0.06, 0, -0.001],
]

test('replays all account, allocation, and cost combinations deterministically on the same sessions', () => {
  const report = simulate(returnProbes)
  expect(report).toEqual(simulate(returnProbes))
  expect(report.runs).toHaveLength(27)
  expect(report.coverage).toEqual({
    warmupFrom: dates[0],
    warmupThrough: dates[1],
    from: dates[2],
    through: dates[3],
    sessions: 2,
  })
  const baseline = run(report, Allocation.Static)
  expect(run(report, Allocation.Static, 0, Account.PaperMain)).toEqual({ ...baseline, account: Account.PaperMain })
  expect(
    run(
      simulate(returnProbes, { startingEquityUsd: { ...scenario.startingEquityUsd, [Account.LiveMain]: 250_000 } }),
      Allocation.Static,
    ).endingEquityUsd,
  ).toBeCloseTo(baseline.endingEquityUsd * 2.5, 8)
  expect(run(report, Allocation.Static, 0, Account.PaperSmall).startingEquityUsd).toBe(10_000)
})

test('charges one-way turnover against marked weights and compounds net performance', () => {
  const report = simulate(returnProbes)
  const zero = run(report, Allocation.Static, 0)
  const two = run(report, Allocation.Static, 2)
  const five = run(report, Allocation.Static, 5)
  const firstGross = 0.0211
  const secondGross = -0.0121
  const firstFactor = (1 - 0.9 * 0.0002) * (1 + firstGross)
  const secondTurnover =
    [0.33, 0.285, 0.306, 0.1001]
      .map((marked, i) => Math.abs(marked / (1 + firstGross) - [0.3, 0.3, 0.3, 0.1][i]))
      .reduce((total, value) => total + value, 0) / 2
  const secondFactor = (1 - secondTurnover * 0.0002) * (1 + secondGross)
  expect(two.daily[0].turnover).toBeCloseTo(0.9, 12)
  expect(two.daily[0].dragUsd).toBeCloseTo(18, 12)
  expect(two.daily[1].turnover).toBeCloseTo(secondTurnover, 12)
  expect(two.daily[1].dragUsd).toBeCloseTo(100_000 * firstFactor * secondTurnover * 0.0002, 10)
  expect(two.endingEquityUsd).toBeCloseTo(100_000 * firstFactor * secondFactor, 8)
  expect(zero.endingEquityUsd).toBeGreaterThan(two.endingEquityUsd)
  expect(two.endingEquityUsd).toBeGreaterThan(five.endingEquityUsd)

  const growth = (firstFactor * secondFactor) ** (365.2425 / 2) - 1
  const drawdown = 1 - secondFactor
  const average = (firstFactor + secondFactor - 2) / 2
  expect(two.metrics.cagr).toBeCloseTo(growth, 9)
  expect(two.metrics.maxDrawdown).toBeCloseTo(drawdown, 12)
  expect(two.metrics.calmar).toBeCloseTo(growth / drawdown, 8)
  expect(two.metrics.sharpe).toBeCloseTo((average * Math.sqrt(504)) / (firstFactor - secondFactor), 12)
  expect(two.metrics.sortino).toBeCloseTo((average * Math.sqrt(504)) / drawdown, 12)
})

test('inverse-vol uses only prior closes, keeps the SHY reserve, and parks a flat sleeve in SHY', () => {
  const inverse = run(simulate(returnProbes), Allocation.InverseVol)
  expect(inverse.daily[0].weights.B0).toBeCloseTo((0.9 * 4) / 7, 12)
  expect(inverse.daily[0].weights.F4).toBeCloseTo((0.9 * 2) / 7, 12)
  expect(inverse.daily[0].weights.O1).toBeCloseTo(0.9 / 7, 12)
  expect(inverse.daily[0].weights.SHY).toBeCloseTo(0.1, 12)
  const changed = run(
    simulate([returnProbes[0], returnProbes[1], [-0.9, 0, 0, 0.8], returnProbes[3]]),
    Allocation.InverseVol,
  )
  expect(changed.daily[0].weights).toEqual(inverse.daily[0].weights)
  expect(changed.daily[1].weights).not.toEqual(inverse.daily[1].weights)

  const flat = run(
    simulate([[-0.02, 0.01, -0.06, 0.09], [0.02, 0.01, 0.06, -0.09], ...returnProbes.slice(2)]),
    Allocation.InverseVol,
  )
  expect(flat.daily[0].weights.F4).toBe(0)
  expect(flat.daily[0].weights.B0).toBeCloseTo(0.45, 12)
  expect(flat.daily[0].weights.O1).toBeCloseTo(0.15, 12)
  expect(flat.daily[0].weights.SHY).toBeCloseTo(0.4, 12)
})

test('reserves a full B0 batch before trading, rolls by sessions, and never shares quotas', () => {
  const trades = [2, 1, 0, 1, 1, 1, 2, 2]
  const rows: Row[] = [
    ...returnProbes.slice(0, 2),
    ...trades.map((count): Row => [count === 0 ? 0 : 0.02, 0, 0, 0.002, count]),
  ]
  const report = simulate(rows)
  const small = run(report, Allocation.Static, 0, Account.PaperSmall)
  const main = run(report, Allocation.Static)
  expect(main.daily.map((day) => day.dayTradesExecuted)).toEqual(trades)
  expect(main.pdt.peakUtilization).toBeNull()
  expect(small.daily.map((day) => day.dayTradesExecuted)).toEqual([2, 0, 0, 0, 0, 1, 2, 0])
  expect(small.daily.map((day) => day.rollingDayTrades)).toEqual([2, 2, 2, 2, 2, 1, 3, 3])
  expect(small.daily[1].weights.B0).toBe(0)
  expect(small.daily[1].weights.SHY).toBeCloseTo(0.4, 12)
  expect(small.daily[1].netReturn).toBeCloseTo(0.0008, 12)
  expect(small.daily[2].pdtBlocked).toBe(true)
  expect(small.daily[2].dayTradesBlocked).toBe(0)
  expect(small.pdt).toEqual({
    windowSessions: 5,
    limit: 3,
    peakRollingDayTrades: 3,
    peakUtilization: 1,
    executedDayTrades: 5,
    blockedDayTrades: 5,
    blockedSessions: 5,
  })
  const noQuota = run(simulate(rows, { pdtMaxDayTrades: 0 }), Allocation.Static, 0, Account.PaperSmall)
  expect(noQuota.pdt.executedDayTrades).toBe(0)
  expect(noQuota.pdt.peakUtilization).toBeNull()
})

test('throttles and recovers from the preceding close, including drag in the high-water mark', () => {
  const aligned = (returns: readonly number[]): Row[] => returns.map((ret) => [ret, ret, ret, 0])
  const report = simulate(aligned([-0.01, 0.01, -0.08, -0.2, 0.5, 0.2, 0.01]))
  const governed = run(report, Allocation.DrawdownGoverned)
  expect(governed.daily.map((day) => day.riskScale)).toEqual([1, 0.5, 0.25, 0.5, 1])
  expect(governed.daily[1].weights.SHY).toBeCloseTo(0.55, 12)
  expect(governed.daily[2].weights.SHY).toBeCloseTo(0.775, 12)
  expect(governed.throttledSessions).toBe(2)
  expect(governed.severeSessions).toBe(1)
  expect(governed.metrics.maxDrawdown).toBeCloseTo(1 - 0.928 * 0.91, 12)
  expect(run(report, Allocation.InverseVol).metrics.maxDrawdown).toBeGreaterThan(governed.metrics.maxDrawdown)

  const near = simulate(aligned([-0.01, 0.01, -0.0498 / 0.9, 0.02]))
  expect(run(near, Allocation.DrawdownGoverned).daily[1].riskScale).toBe(1)
  expect(run(near, Allocation.DrawdownGoverned, 5).daily[1].riskScale).toBe(0.5)
})

test('measures rolling positive correlation spikes and simultaneous negative tails on matched dates', () => {
  const report = simulate(
    [
      [-0.01, 0.02, -0.005, 0],
      [0, -0.01, 0.01, 0],
      [0.01, -0.02, -0.01, 0],
      [-0.01, -0.01, -0.01, 0],
      [-0.03, -0.03, -0.03, 0],
      [0.02, 0.02, 0.02, 0],
      [0.01, -0.02, 0.015, 0],
      [-0.03, -0.04, 0.03, 0],
      [0.01, 0.01, -0.4, 0],
    ],
    { lookbackSessions: 3, correlationThreshold: 0.99, tailFraction: 0.33 },
  )
  expect(report.dependence.pairs).toHaveLength(6)
  expect(report.dependence.pairs[0].sleeves).toEqual([Sleeve.B0, Sleeve.F4])
  expect(report.dependence.pairs[0].rolling.peak).toEqual({ date: dates[5], correlation: 1 })
  expect(report.dependence.pairs[0].rolling.spikeDates).toContain(dates[5])
  expect(report.dependence.pairs[0].tailCoDrawdownDates).toEqual([dates[4], dates[7]])
  expect(report.dependence.pairs[2]).toEqual({
    sleeves: [Sleeve.B0, Sleeve.SHY],
    correlation: null,
    rolling: { peak: null, definedWindows: 0, spikeDates: [] },
    tailCoDrawdownDates: [],
  })
  expect(report.dependence.allRiskTailDates).toEqual([dates[4]])
  expect(run(report, Allocation.Static).worstCoDrawdownReturn).toBeCloseTo(-0.027, 12)
  expect(run(report, Allocation.Static).worstSpikeReturn).not.toBeNull()
})

test('keeps undefined ratios explicit and refuses unrepresentable equity or annualization', () => {
  const flat: Row = [0, 0, 0, 0, 0]
  expect(run(simulate([flat, flat, flat, flat]), Allocation.InverseVol).metrics).toEqual({
    cagr: 0,
    sharpe: null,
    sortino: null,
    calmar: null,
    maxDrawdown: 0,
  })
  const extreme = Result.getOrThrow(
    decodePortfolioEvidence(fixture([returnProbes[0], returnProbes[1], [1e300, 0, 0, 0], returnProbes[3]])),
  )
  expect(Result.isFailure(simulatePortfolio(extreme, scenario))).toBe(true)
})

test('rejects malformed, partial, unordered, or internally inconsistent evidence', () => {
  const good = fixture(returnProbes)
  const b0 = (sessions: readonly unknown[]) => ({
    ...good,
    sleeves: { ...good.sleeves, B0: { ...good.sleeves.B0, sessions } },
  })
  const [head, ...rest] = good.sleeves.B0.sessions
  const secret = 'private-canary-that-must-not-be-echoed'
  const invalid = [
    { ...good, schemaVersion: 'unknown' },
    { ...good, calendar: { ...good.calendar, sourceSha256: 'wrong' } },
    { ...good, calendar: { ...good.calendar, sessions: [...good.calendar.sessions].reverse() } },
    {
      ...good,
      calendar: { ...good.calendar, sessions: [good.calendar.sessions[0], ...good.calendar.sessions.slice(0, -1)] },
    },
    { ...good, sleeves: { B0: good.sleeves.B0, F4: good.sleeves.F4, O1: good.sleeves.O1 } },
    { ...good, unexpected: secret },
    b0(rest),
    b0([...rest, head]),
    b0([head, head, ...rest.slice(1)]),
    b0([{ ...head, date: '2024-02-30' }, ...rest]),
    b0([{ ...head, netReturn: null }, ...rest]),
    b0([{ ...head, netReturn: -1 }, ...rest]),
    b0([{ ...head, netReturn: Number.NaN }, ...rest]),
    b0([{ date: head.date, netReturn: head.netReturn }, ...rest]),
    b0([{ ...head, dayTradeCount: 1.5 }, ...rest]),
    b0([{ ...head, dayTradeCount: -1 }, ...rest]),
  ]
  for (const input of invalid) {
    const result = decodePortfolioEvidence(input)
    expect(Result.isFailure(result)).toBe(true)
    expect(inspect(result)).not.toContain(secret)
  }

  for (const rows of [
    returnProbes.slice(0, 3),
    [[0.01, 0, 0, 0, 0], ...returnProbes.slice(1)],
    [[0.01, 0, 0, 0, 3], ...returnProbes.slice(1)],
  ] satisfies readonly (readonly Row[])[]) {
    const evidence = Result.getOrThrow(decodePortfolioEvidence(fixture(rows)))
    expect(Result.isFailure(simulatePortfolio(evidence, scenario))).toBe(true)
  }
})

test('rejects incomplete, levered, or invalid scenario parameters', () => {
  for (const input of [
    { ...scenario, weights: { B0: 0.3, F4: 0.3, SHY: 0.4 } },
    { ...scenario, weights: { ...scenario.weights, SHY: 0.3 } },
    { ...scenario, weights: { ...scenario.weights, SHY: -0.01 } },
    { ...scenario, lookbackSessions: 1 },
    { ...scenario, pdtMaxDayTrades: -1 },
    { ...scenario, b0DayTradeReservation: 0 },
    { ...scenario, correlationThreshold: 1.01 },
    { ...scenario, tailFraction: 0 },
    { ...scenario, startingEquityUsd: { ...scenario.startingEquityUsd, [Account.PaperSmall]: 0 } },
    { ...scenario, drawdown: { ...scenario.drawdown, severeAt: 0.01 } },
    { ...scenario, drawdown: { ...scenario.drawdown, severeScale: 0.75 } },
  ])
    expect(Result.isFailure(decodePortfolioScenario(input))).toBe(true)
})

const withFiles = async (
  use: (paths: { fixturePath: string; scenarioPath: string; json: string; digest: string }) => Promise<void>,
) => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-multi-sleeve-'))
  const fixturePath = join(dir, 'returns.json')
  const scenarioPath = join(dir, 'scenario.json')
  const json = JSON.stringify(fixture(returnProbes))
  try {
    await writeFile(fixturePath, json)
    await writeFile(scenarioPath, JSON.stringify(scenario))
    await use({ fixturePath, scenarioPath, json, digest: sha256(json) })
  } finally {
    await rm(dir, { recursive: true })
  }
}

const archiveConfig = ConfigProvider.fromUnknown({
  AWS_ACCESS_KEY_ID: 'test-key',
  AWS_SECRET_ACCESS_KEY: 'private-test-key',
})
const archiveKey = 'bayn-research-datasets/fixture/portfolio.json'

test('emits the same report for pinned file and archive bytes; the CLI withholds unverified evidence', async () => {
  await withFiles(async ({ fixturePath, scenarioPath, json, digest }) => {
    const cmd = [process.execPath, join(import.meta.dir, 'simulate-multi-sleeve-portfolio.ts')]
    const options = ['--scenario', scenarioPath, '--sha256', digest]
    const local = Bun.spawnSync([...cmd, '--fixture', fixturePath, ...options])
    expect(local.exitCode).toBe(0)
    expect(local.stderr.toString()).toBe('')
    expect(local.stdout.toString()).toContain('bayn.multi-sleeve-portfolio-simulation.v1')
    expect(local.stdout.toString()).toContain(digest)
    expect(local.stdout.toString()).not.toContain('"daily":')
    let reads = 0
    const signedGet = (url: string, init: BunFetchRequestInit) => {
      reads++
      expect(new URL(url).pathname).toBe(`/agents-artifacts/${archiveKey}`)
      expect(init.method ?? 'GET').toBe('GET')
      return Promise.resolve(new Response(json))
    }
    const archive = await Effect.runPromise(
      runPortfolioCommand(['--archive', archiveKey, ...options], signedGet).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, archiveConfig),
      ),
    )
    expect(reads).toBe(1)
    expect(local.stdout.toString()).toBe(`${archive}\n`)
    const daily = Bun.spawnSync([...cmd, '--fixture', fixturePath, ...options, '--daily'])
    expect(daily.exitCode).toBe(0)
    expect(daily.stdout.toString()).toContain('"daily":')

    const rejected = Bun.spawnSync([...cmd, '--fixture', fixturePath, '--sha256', sha256(`${json}\n`)])
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stdout.toString()).toBe('')
    expect(rejected.stderr.toString()).toContain('Fixture SHA-256 mismatch')
    const rejectedArchive = await Effect.runPromise(
      Effect.result(
        runPortfolioCommand(['--archive', archiveKey, ...options], () =>
          Promise.resolve(new Response(`${json}\n`)),
        ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, archiveConfig)),
      ),
    )
    expect(Result.isFailure(rejectedArchive)).toBe(true)
  })
})

test('rejects ambiguous or unpinned inputs and redacts command and transport errors', async () => {
  const secret = 'never-log-this-input'
  for (const args of [
    [],
    ['--fixture', 'a'],
    ['--fixture', 'a', '--archive', 'b', '--sha256', receipt],
    ['--fixture', 'a', '--sha256', receipt, '--sha256', receipt],
    ['--fixture', 'a', '--sha256', secret],
    [`--${secret}`],
  ]) {
    const result = await Effect.runPromise(Effect.result(runPortfolioCommand(args)))
    expect(Result.isFailure(result)).toBe(true)
    expect(inspect(result)).not.toContain(secret)
  }
  const failure = await Effect.runPromise(
    Effect.result(
      runPortfolioCommand(['--archive', secret, '--sha256', receipt], () => Promise.reject(new Error(secret))).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, archiveConfig),
      ),
    ),
  )
  expect(Result.isFailure(failure)).toBe(true)
  expect(inspect(failure)).not.toContain(secret)
})

test.each(['interruption', 'timeout'] as const)('%s cancels the in-flight archive GET once', async (mode) => {
  let aborts = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const command = runPortfolioCommand(
        ['--archive', archiveKey, '--sha256', receipt],
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                aborts++
                reject(new Error('aborted'))
                Deferred.doneUnsafe(aborted, Effect.void)
              },
              { once: true },
            )
            Deferred.doneUnsafe(started, Effect.void)
          }),
      ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, archiveConfig))
      const fiber = yield* Effect.forkScoped(Effect.result(command))
      yield* Deferred.await(started)
      if (mode === 'interruption') yield* Fiber.interrupt(fiber)
      else {
        yield* TestClock.adjust('30 seconds')
        expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      }
      yield* Deferred.await(aborted)
    }).pipe(Effect.scoped, (self) => provideTestLayer(self, TestClock.layer())),
  )
  expect(aborts).toBe(1)
})
