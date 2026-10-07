import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1, sha256 } from '../hash'
import { runRidgeTrainingCommand } from '../ridge-training-command'
import { utcInstantFromEpochMillis } from '../time'
import { ControlStudyFailure } from './control-portfolio'
import { failureDetails } from './control-study'
import { prepareRidgeTraining, runRidgeTraining } from './ridge-training'
import { ridgeTrainingFixture } from './ridge-training.test-support'
import { RidgeTrainingOutcome } from './ridge-training-selection'

test('original receipts generate causal labels from partial fills with serial cash and turnover, then fit a callable command', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = ridgeTrainingFixture()
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.ndjson.gz`
      yield* fs.writeFile(arrivals, fixture.body)
      const report = yield* runRidgeTraining(fixture.input, arrivals, fixture.receipt)
      expect(report.status).toBe('FITTED')
      expect(report.artifact).not.toBeNull()
      expect(report.chains).toHaveLength(fixture.protocol.candidateSymbols.length)
      expect(report.rows).toHaveLength(fixture.protocol.candidateSymbols.length * 4)
      for (const chain of report.chains) {
        expect(chain.failure).toBeNull()
        expect(chain.skippedSessionDates).toEqual([])
        const [first, second] = chain.sessions
        expect(first?.completion).toBe('COMPLETE')
        expect(second?.completion).toBe('COMPLETE')
        const attempts = first?.trainingAttempts ?? []
        expect(attempts).toHaveLength(2)
        expect(attempts.map((attempt) => attempt.outcome)).toEqual([
          RidgeTrainingOutcome.Resolved,
          RidgeTrainingOutcome.Resolved,
        ])
        expect(first?.ledger.fills.map((fill) => fill.quantityMicros)).toEqual([
          '5000000',
          '2000000',
          '2000000',
          '1000000',
          '5000000',
          '2000000',
          '2000000',
          '1000000',
        ])
        expect(attempts[0]?.openingCashMicros).toBe('100000000000')
        expect(attempts[0]?.openingTurnoverMicros).toBe('0')
        expect(BigInt(attempts[1]?.openingTurnoverMicros ?? '0')).toBeGreaterThan(0n)
        expect(attempts[1]?.openingCashMicros).toBe(
          (100000000000n + BigInt(attempts[0]?.netExecutionPnlMicros ?? '0')).toString(),
        )
        expect(second?.trainingAttempts?.[0]?.openingCashMicros).toBe(first?.closingCapital.cashMicros)
        expect(second?.trainingAttempts?.[0]?.openingTurnoverMicros).toBe('0')
        for (const [index, attempt] of attempts.entries()) {
          expect(attempt.features.availableAt <= attempt.features.decisionAt).toBeTrue()
          expect(attempt.netExecutionPnlMicros).toBe(first?.episodes[index]?.netExecutionPnlMicros)
          expect(attempt.completeAt).toBe(utcInstantFromEpochMillis(first!.episodes[index]!.exitedAtMs))
          expect(attempt.orders).toHaveLength(4)
        }
      }
      const inputText = JSON.stringify(fixture.input)
      yield* fs.writeFileString(`${directory}/input.json`, inputText)
      yield* fs.writeFileString(`${directory}/receipt.json`, fixture.receiptText)
      const args = [
        '--input',
        `${directory}/input.json`,
        '--input-sha256',
        sha256(inputText),
        '--arrivals',
        arrivals,
        '--source-receipt',
        `${directory}/receipt.json`,
        '--source-receipt-sha256',
        sha256(fixture.receiptText),
        '--output',
        `${directory}/report.json`,
      ]
      yield* runRidgeTrainingCommand(args)
      const fromCommand = JSON.parse(yield* fs.readFileString(`${directory}/report.json`)) as { reportHash: string }
      expect(fromCommand.reportHash).toBe(report.reportHash)
      expect(Result.isFailure(yield* Effect.result(runRidgeTrainingCommand(args)))).toBeTrue()
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  )
}, 60_000)

test.each(['unresolved', 'excluded'] as const)(
  '%s produces an explicit no-artifact diagnostic',
  async (mode) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = ridgeTrainingFixture(mode)
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const arrivals = `${directory}/arrivals.ndjson.gz`
        yield* fs.writeFile(arrivals, fixture.body)
        const inputText = JSON.stringify(fixture.input)
        yield* fs.writeFileString(`${directory}/input.json`, inputText)
        yield* fs.writeFileString(`${directory}/receipt.json`, fixture.receiptText)
        const outcome = yield* Effect.result(
          runRidgeTrainingCommand([
            '--input',
            `${directory}/input.json`,
            '--input-sha256',
            sha256(inputText),
            '--arrivals',
            arrivals,
            '--source-receipt',
            `${directory}/receipt.json`,
            '--source-receipt-sha256',
            sha256(fixture.receiptText),
            '--output',
            `${directory}/diagnostic.json`,
          ]),
        )
        expect(Result.isFailure(outcome)).toBeTrue()
        const report = JSON.parse(yield* fs.readFileString(`${directory}/diagnostic.json`)) as Effect.Success<
          ReturnType<typeof runRidgeTraining>
        >
        expect(report.artifact).toBeNull()
        expect(report.rows).toEqual([])
        expect(report.status).toBe(mode === 'unresolved' ? 'INCOMPLETE' : 'NO_TRAINING_ROWS')
        if (mode === 'unresolved') {
          expect(report.unresolvedAttempts).toBe(fixture.protocol.candidateSymbols.length)
          expect(report.chains[0]?.skippedSessionDates).toEqual(['2026-09-02'])
          expect(report.chains[0]?.sessions[0]?.trainingAttempts?.[0]).toMatchObject({
            outcome: RidgeTrainingOutcome.Unresolved,
            completeAt: null,
            netExecutionPnlMicros: null,
          })
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
    )
  },
  60_000,
)

test('pinned calendar rejects an omitted middle training day and source reaching beyond the fit boundary', () => {
  const fixture = ridgeTrainingFixture()
  expect(Result.isSuccess(prepareRidgeTraining(fixture.input, fixture.receipt))).toBeTrue()
  const calendar = fixture.input.calendar.map((day, index) => (index === 1 ? { ...day, date: '2026-09-01' } : day))
  const omitted = {
    ...fixture.input,
    sessions: fixture.input.sessions.filter((_, index) => index !== 1),
    backtest: {
      ...fixture.input.backtest,
      sessionDates: ['2026-09-01'],
      calendar: fixture.input.backtest.calendar.filter((_, index) => index !== 1),
    },
  }
  expect(Result.isFailure(prepareRidgeTraining(omitted, fixture.receipt))).toBeTrue()
  expect(
    Result.isFailure(
      prepareRidgeTraining(
        { ...fixture.input, calendar, expectedCalendarHash: canonicalHashV1(calendar) },
        fixture.receipt,
      ),
    ),
  ).toBeTrue()
  expect(
    Result.isFailure(
      prepareRidgeTraining({ ...fixture.input, fitCutoffAt: '2026-09-02T13:45:00.000Z' }, fixture.receipt),
    ),
  ).toBeTrue()
})

test('known canceled entries retain zero cash labels and are eligible for fitting', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = ridgeTrainingFixture()
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.ndjson.gz`
      yield* fs.writeFile(arrivals, fixture.body)
      const input = {
        ...fixture.input,
        backtest: {
          ...fixture.input.backtest,
          assumptions: { ...fixture.input.backtest.assumptions, availableLiquidityPpm: 1 },
        },
      }
      const report = yield* runRidgeTraining(input, arrivals, fixture.receipt)
      expect(report.status).toBe('FITTED')
      expect(report.rows.length).toBeGreaterThan(0)
      expect(
        report.rows.every((row) => row.label.status === 'NO_ENTRY_FILL' && row.label.netExecutionPnlMicros === '0'),
      ).toBeTrue()
      for (const chain of report.chains)
        for (const session of chain.sessions) {
          expect(session.ledger.fills).toEqual([])
          expect(session.closingCapital.cashMicros).toBe(fixture.input.backtest.openingCashMicros)
          expect(
            session.trainingAttempts?.every((attempt) => attempt.reason === 'CANCELED' && attempt.completeAt !== null),
          ).toBeTrue()
        }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  )
}, 60_000)

test('diagnostics preserve typed nested causes', () => {
  const inner = new ControlStudyFailure({ message: 'Missing source quote at exact close' })
  const outer = new ControlStudyFailure({ message: 'Control session failed', cause: inner })
  const detail = Result.getOrThrow(failureDetails(outer))
  expect(detail).toContain('Control session failed')
  expect(detail).toContain('Missing source quote at exact close')
  expect(detail).toContain('ControlStudyFailure')
})
