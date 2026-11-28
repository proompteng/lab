import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Redacted, Result } from 'effect'

import { shortEligibilityFixture } from '../src/execution/equity-short.test-support'
import {
  Anomaly,
  decodeCorporateActionHygieneEvidence,
  Flag,
  HygieneErrorCode,
  HygieneStatus,
  OvernightGapUse,
  Sleeve,
  verifyCorporateActionHygiene,
  type CorporateActionHygieneEvidence,
} from './corporate-action-hygiene-core'
import { BarAdjustment } from './macro-canary-runner/alpaca'
import { runCorporateActionHygiene } from './verify-corporate-action-hygiene'

const previousSession = '2026-11-20'
const session = '2026-11-23'
const executionSession = '2026-11-24'
const accountId = '11111111-1111-4111-8111-111111111111'
const decisionAt = `${session}T15:00:00.000Z`
const observedAt = `${session}T14:59:50.000Z`
const eligibility = shortEligibilityFixture(accountId, 'QQQ', observedAt)

type Observation = CorporateActionHygieneEvidence['observations'][number]
type Daily = Exclude<Observation, { sleeve: Sleeve.B0 }>
type Intraday = Extract<Observation, { sleeve: Sleeve.B0 }>
type CorporateAction = CorporateActionHygieneEvidence['corporateActions'][number]
const window = {
  symbol: 'QQQ',
  session,
  previousSession,
  rawPreviousCloseMicros: 100_000_000,
  rawOpenMicros: 101_000_000,
} as const

const daily = (sleeve: Daily['sleeve'] = Sleeve.F4): Daily => ({
  ...window,
  sleeve,
  signal: {
    basis: BarAdjustment.All,
    previousCloseMicros: 50_000_000,
    openMicros: 50_500_000,
    closeMicros: 51_000_000,
  },
  sizing: {
    basis: BarAdjustment.Raw,
    priceMicros: 102_000_000,
    rawCloseMicros: 102_000_000,
    executionSession,
    referenceSession: session,
  },
})

const intraday = (overrides: Partial<Intraday> = {}): Intraday => ({
  ...window,
  sleeve: Sleeve.B0,
  accountId,
  overnightGapUse: OvernightGapUse.UsedForAlpha,
  shortEntries: [{ decisionAt, eligibility }],
  ...overrides,
})

const action = (overrides: Partial<CorporateAction> = {}): CorporateAction => ({
  symbol: 'QQQ',
  session,
  split: null,
  cashDividendMicros: 0,
  ...overrides,
})
const evidence = (...observations: CorporateActionHygieneEvidence['observations']): CorporateActionHygieneEvidence => ({
  schemaVersion: 'bayn.corporate-action-hygiene-evidence.v1',
  calendar: [previousSession, session, executionSession],
  corporateActions: [action(), action({ session: executionSession }), action({ symbol: 'SMH' })],
  observations,
})
const withAction = (
  input: CorporateActionHygieneEvidence,
  action: CorporateAction,
): CorporateActionHygieneEvidence => ({
  ...input,
  corporateActions: input.corporateActions.map((row) =>
    row.symbol === action.symbol && row.session === action.session ? action : row,
  ),
})

const verify = (input: CorporateActionHygieneEvidence) =>
  verifyCorporateActionHygiene(Result.getOrThrow(decodeCorporateActionHygieneEvidence(JSON.stringify(input))))

test('accepts both daily sleeves with all-adjusted signals and raw sizing, and B0 with fresh account-bound ETB', () => {
  expect(verify(evidence(daily(), daily(Sleeve.O1), intraday()))).toEqual({
    schemaVersion: 'bayn.corporate-action-hygiene-report.v1',
    status: HygieneStatus.Pass,
    checkedBySleeve: { B0: 1, F4: 1, O1: 1 },
    flags: [],
    anomalies: [],
  })
})

test('blocks both directions of unexplained overnight discontinuities strictly beyond 20%', () => {
  for (const openMicros of [80_000_000, 120_000_000]) {
    expect(verify(evidence(intraday({ rawOpenMicros: openMicros }))).status).toBe(HygieneStatus.Pass)
  }
  for (const openMicros of [79_999_999, 120_000_001]) {
    const macro = daily()
    const report = verify(
      evidence(
        {
          ...macro,
          rawOpenMicros: openMicros,
          signal: { ...macro.signal, previousCloseMicros: 100_000_000, openMicros, closeMicros: 102_000_000 },
        },
        intraday({ rawOpenMicros: openMicros, overnightGapUse: OvernightGapUse.Excluded }),
      ),
    )
    expect(report.status).toBe(HygieneStatus.Fail)
    expect(report.anomalies).toEqual([
      { observation: 0, code: Anomaly.OvernightDiscontinuity },
      { observation: 1, code: Anomaly.OvernightDiscontinuity },
    ])
  }
})

test('forward and reverse splits need adjusted signal marks and exclusion from B0 gap inputs', () => {
  for (const [fromShares, toShares, postSplitMicros] of [
    [1, 2, 50_000_000],
    [2, 1, 200_000_000],
  ]) {
    const raw = { rawOpenMicros: postSplitMicros }
    const split = action({ split: { fromShares, toShares } })
    const macro = daily()
    const adjusted = {
      ...macro,
      ...raw,
      signal: {
        ...macro.signal,
        previousCloseMicros: postSplitMicros,
        openMicros: postSplitMicros,
        closeMicros: postSplitMicros,
      },
      sizing: { ...macro.sizing, priceMicros: postSplitMicros, rawCloseMicros: postSplitMicros },
    }
    const skipped = intraday({ ...raw, overnightGapUse: OvernightGapUse.Excluded })
    expect(verify(withAction(evidence(adjusted, skipped), split))).toMatchObject({
      status: HygieneStatus.Pass,
      flags: [
        { observation: 0, code: Flag.SplitGap },
        { observation: 1, code: Flag.SplitGap },
      ],
      anomalies: [],
    })
    const mislabeled = {
      ...adjusted,
      signal: { ...adjusted.signal, previousCloseMicros: window.rawPreviousCloseMicros },
    }
    expect(verify(withAction(evidence(mislabeled, intraday(raw)), split)).anomalies).toEqual([
      { observation: 0, code: Anomaly.SignalAdjustmentMismatch },
      { observation: 0, code: Anomaly.OvernightDiscontinuity },
      { observation: 1, code: Anomaly.CorporateActionGapUsedForAlpha },
    ])
  }
})

test('flags even an up-open on the ex-date and blocks it if B0 used it for alpha', () => {
  const dividend = action({ cashDividendMicros: 500_000 })
  const macro = daily(Sleeve.O1)
  const adjusted = { ...macro, signal: { ...macro.signal, previousCloseMicros: 49_750_000 } }
  const otherSymbol = intraday({ symbol: 'SMH', shortEntries: [] })
  const report = verify(withAction(evidence(adjusted, intraday(), otherSymbol), dividend))
  expect(report.flags).toEqual([
    { observation: 0, code: Flag.ExDividendGap },
    { observation: 1, code: Flag.ExDividendGap },
  ])
  expect(report.anomalies).toEqual([{ observation: 1, code: Anomaly.CorporateActionGapUsedForAlpha }])
  expect(verify(withAction(evidence(macro), dividend)).anomalies).toEqual([
    { observation: 0, code: Anomaly.SignalAdjustmentMismatch },
  ])
  expect(verify(withAction(evidence(macro), action({ cashDividendMicros: 1_000 }))).anomalies).toEqual([
    { observation: 0, code: Anomaly.SignalAdjustmentMismatch },
  ])
  const excluded = intraday({ overnightGapUse: OvernightGapUse.Excluded })
  expect(verify(withAction(evidence(adjusted, excluded), dividend)).status).toBe(HygieneStatus.Pass)
  expect(verify(withAction(evidence({ ...excluded, rawOpenMicros: 50_000_000 }), dividend)).anomalies).toEqual([
    { observation: 0, code: Anomaly.OvernightDiscontinuity },
  ])
})

test('uses post-split shares for simultaneous cash dividends and rejects impossible or unavailable action evidence', () => {
  const macro = daily()
  expect(
    verify(
      withAction(
        evidence({
          ...macro,
          rawOpenMicros: 32_000_000,
          signal: { ...macro.signal, previousCloseMicros: 32_333_333, openMicros: 32_000_000, closeMicros: 32_000_000 },
          sizing: { ...macro.sizing, priceMicros: 32_000_000, rawCloseMicros: 32_000_000 },
        }),
        action({ split: { fromShares: 1, toShares: 3 }, cashDividendMicros: 1_000_000 }),
      ),
    ),
  ).toMatchObject({ status: HygieneStatus.Pass, flags: [{ code: Flag.ExDividendGap }, { code: Flag.SplitGap }] })
  expect(
    verify(withAction(evidence(macro), action({ cashDividendMicros: window.rawPreviousCloseMicros }))).anomalies,
  ).toEqual([{ observation: 0, code: Anomaly.InvalidCorporateAction }])
  const missing = evidence({ ...macro, rawOpenMicros: 50_000_000, signal: { ...macro.signal, openMicros: 25_000_000 } })
  expect(verify({ ...missing, corporateActions: missing.corporateActions.slice(1) }).anomalies).toEqual([
    { observation: 0, code: Anomaly.MissingCorporateActionEvidence },
    { observation: 0, code: Anomaly.OvernightDiscontinuity },
  ])
})

test('rejects a raw close leaked into the adjusted signal bar even with a clean overnight transition', () => {
  const macro = daily()
  expect(
    verify(evidence({ ...macro, signal: { ...macro.signal, closeMicros: macro.sizing.rawCloseMicros } })).anomalies,
  ).toEqual([{ observation: 0, code: Anomaly.SignalAdjustmentMismatch }])
})

test('rejects swapped bases, a mislabeled raw sizing price, stale references and a next-open share change', () => {
  for (const sleeve of [Sleeve.F4, Sleeve.O1] as const) {
    const macro = daily(sleeve)
    const { signal, sizing } = macro
    expect(
      verify(
        evidence({
          ...macro,
          signal: { ...signal, basis: BarAdjustment.Raw },
          sizing: { ...sizing, basis: BarAdjustment.All },
        }),
      ).anomalies,
    ).toEqual([
      { observation: 0, code: Anomaly.SignalPriceBasisMismatch },
      { observation: 0, code: Anomaly.SizingPriceBasisMismatch },
    ])
    expect(
      verify(
        withAction(
          evidence({
            ...macro,
            sizing: { ...sizing, priceMicros: signal.openMicros, referenceSession: previousSession },
          }),
          action({ session: executionSession, split: { fromShares: 1, toShares: 2 } }),
        ),
      ).anomalies,
    ).toEqual([
      { observation: 0, code: Anomaly.SizingPriceBasisMismatch },
      { observation: 0, code: Anomaly.InvalidSizingSession },
      { observation: 0, code: Anomaly.NextOpenSplit },
    ])
    expect(verify({ ...evidence(macro), corporateActions: [action()] }).anomalies).toEqual([
      { observation: 0, code: Anomaly.MissingNextOpenCorporateActionEvidence },
    ])
  }
})

test('checks every B0 short for missing, negative, stale, future or misbound broker observations', () => {
  const shortEntries = [
    { decisionAt, eligibility },
    { decisionAt, eligibility: null },
    ...[
      { easyToBorrow: false },
      { easyToBorrow: null },
      { shortable: false },
      { shortingEnabled: null },
      { noShorting: true },
      { assetObservedAt: `${session}T14:59:45.000Z` }, // The 15 s limit is exclusive.
      { configurationObservedAt: `${session}T15:00:00.001Z` },
      { accountId: 'another-account' },
      { symbol: 'SMH' },
    ].map((change) => ({ decisionAt, eligibility: { ...eligibility, ...change } })),
    {
      decisionAt: `${previousSession}T15:00:00.000Z`,
      eligibility: shortEligibilityFixture(accountId, 'QQQ', `${previousSession}T14:59:50.000Z`),
    },
  ]
  const report = verify(evidence(intraday({ shortEntries })))
  expect(report.status).toBe(HygieneStatus.Fail)
  expect(report.anomalies).toEqual([
    { observation: 0, shortEntry: 1, code: Anomaly.MissingShortEligibility },
    ...Array.from({ length: 9 }, (_, i) => ({ observation: 0, shortEntry: 2 + i, code: Anomaly.IneligibleShort })),
    { observation: 0, shortEntry: 11, code: Anomaly.InvalidShortDecisionSession },
  ])
})

test('rejects repeated observations, nonadjacent bars and a sizing session missing from the calendar', () => {
  const macro = daily()
  expect(verify(evidence(macro, macro)).anomalies).toEqual([{ observation: 1, code: Anomaly.DuplicateObservation }])
  expect(verify(evidence(intraday({ previousSession: '2026-11-19' }))).anomalies).toEqual([
    { observation: 0, code: Anomaly.InvalidSessionPair },
  ])
  expect(verify({ ...evidence(macro), calendar: [previousSession, session] }).anomalies).toEqual([
    { corporateAction: 1, code: Anomaly.InvalidCorporateActionSession },
    { observation: 0, code: Anomaly.InvalidSizingSession },
  ])
})

test('only uses action evidence for the same symbol and effective session, and rejects conflicting rows', () => {
  const adjacent = action({ session: previousSession, split: { fromShares: 2, toShares: 1 } })
  const other = action({ symbol: 'SMH', cashDividendMicros: 500_000 })
  const input = evidence(intraday())
  expect(verify({ ...input, corporateActions: [adjacent, other] }).anomalies).toEqual([
    { observation: 0, code: Anomaly.MissingCorporateActionEvidence },
  ])
  expect(verify({ ...input, corporateActions: [action(), action({ cashDividendMicros: 500_000 })] }).anomalies).toEqual(
    [{ corporateAction: 1, code: Anomaly.DuplicateCorporateActionEvidence }],
  )
})

test('requires a nonempty, strictly decoded evidence slice and explicit gap and short coverage', () => {
  const input = evidence(intraday())
  for (const bad of [
    { ...input, observations: [] },
    { ...input, calendar: [session, previousSession] },
    { ...input, calendar: [previousSession, session, session] },
    { ...input, calendar: ['2026-11-31', session] },
    { ...input, observations: [{ ...intraday(), rawOpenMicros: 0 }] },
    { ...input, observations: [{ ...intraday(), rawOpenMicros: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...input, observations: [{ ...intraday(), overnightGapUse: 'unsure' }] },
    { ...input, observations: [{ ...intraday(), shortEntries: undefined }] },
    { ...input, corporateActions: undefined },
    { ...input, corporateActions: [action({ split: { fromShares: 2, toShares: 2 } })] },
    { ...input, observations: [{ ...daily(), signal: { ...daily().signal, basis: 'split' } }] },
  ]) {
    const error = Result.getOrThrow(Result.flip(decodeCorporateActionHygieneEvidence(JSON.stringify(bad))))
    expect(error.code).toBe(HygieneErrorCode.InvalidEvidence)
    expect(Redacted.isRedacted(error.cause)).toBe(true)
  }
})

test('CLI exits nonzero on anomalies and redacts both malformed evidence and file failures without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-hygiene-'))
  const path = join(dir, 'evidence.json')
  const privateMarker = 'SYNTHETIC_PRIVATE_FIXTURE_VALUE'
  const run = (args: readonly string[]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, 'verify-corporate-action-hygiene.ts'), ...args], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  try {
    for (const input of [evidence(daily(), intraday()), { ...evidence(intraday()), corporateActions: [] }]) {
      const bytes = JSON.stringify(input)
      await writeFile(path, bytes)
      const expected = verify(input)
      const outcome = run(['--input', path])
      expect(outcome.exitCode).toBe(expected.status === HygieneStatus.Pass ? 0 : 1)
      expect(outcome.stdout.toString().trim()).toBe(JSON.stringify(expected))
      expect(outcome.stderr.toString()).toBe('')
      expect(outcome.stdout.toString()).not.toContain(accountId)
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }

    for (const bytes of [
      `{"${privateMarker}":`,
      JSON.stringify({ ...evidence(daily()), [privateMarker]: privateMarker }),
    ]) {
      await writeFile(path, bytes)
      const invalid = run(['--input', path])
      expect(invalid.exitCode).toBe(1)
      expect(invalid.stdout.toString()).toBe('')
      expect(invalid.stderr.toString()).toContain('InvalidEvidence')
      expect(invalid.stderr.toString()).not.toContain(privateMarker)
      expect(invalid.stderr.toString()).not.toContain(dir)
    }
    const missing = run(['--input', join(dir, privateMarker)])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr.toString()).toContain('NotFound')
    expect(missing.stderr.toString()).not.toContain(privateMarker)
    const invalidArg = run(['--some-option', privateMarker])
    expect(invalidArg.exitCode).toBe(1)
    expect(invalidArg.stderr.toString()).toContain('InvalidArguments')
    expect(invalidArg.stderr.toString()).not.toContain(privateMarker)
    expect(run(['--help']).stdout.toString()).toContain('Usage:')
    expect(await readdir(dir)).toEqual(['evidence.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('interruption releases an outstanding read once and does not reclassify defects', async () => {
  const args = ['--input', 'evidence.json']
  let released = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* runCorporateActionHygiene(args).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    released++
                  }),
                ),
              ),
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }),
  )
  expect(released).toBe(1)
  const defect = new Error('unexpected read defect')
  const exit = await Effect.runPromiseExit(
    runCorporateActionHygiene(args).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.die(defect) })),
    ),
  )
  expect(Exit.isFailure(exit) && Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
})
