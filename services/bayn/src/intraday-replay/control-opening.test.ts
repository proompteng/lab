import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deferred, Effect, Fiber, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerEnvironment } from '../broker/identity'
import { sha256 } from '../hash'
import type { ReconciliationPassResult } from '../reconciler'
import { ControlStudyOpeningSchema, ControlStudyPlanSchema } from './control-binding'
import { controlBindingFixture } from './control-binding.test-support'
import { captureControlStudyOpening, retainControlStudyOpening } from './control-opening'

const fixture = () => {
  const raw = controlBindingFixture()
  const plan = Result.getOrThrow(Schema.decodeUnknownResult(ControlStudyPlanSchema)(raw.plan))
  const opening = Result.getOrThrow(Schema.decodeUnknownResult(ControlStudyOpeningSchema)(raw.opening))
  const runtime = {
    broker: opening.broker,
    requestHash: opening.requestHash,
    build: opening.build,
    policy: opening.inputs.policy,
  }
  const {
    portfolio,
    reconciliation,
    accountingExact,
    observedAt,
    policy: _policy,
    schemaVersion: _schema,
    ...risk
  } = opening.inputs
  const pass: ReconciliationPassResult = {
    brokerState: portfolio.brokerState,
    riskContext: {
      ...risk,
      tradingDate: '2026-09-04',
      dailyTradedNotionalMicros: opening.dailyTradedNotionalMicros,
    },
    report: {
      reconciliation,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact,
        discrepancyCount: 0,
      },
    },
  }
  const capture = (reconcile = Effect.succeed(pass)) =>
    captureControlStudyOpening(plan, runtime, {
      readBoundGeneration: Effect.succeed(opening.inputs.authority.generationHash),
      reconcile,
      now: Effect.succeed(observedAt),
    })
  return { plan, opening, runtime, pass, capture }
}

test('native capture retains the exact preflight including accounting identity, peak and used budgets', async () => {
  const x = fixture()
  const actual = await Effect.runPromise(x.capture())
  expect(actual).toEqual(x.opening)
  const used = {
    ...x.pass,
    riskContext: {
      ...x.pass.riskContext,
      dailyTradedNotionalMicros: '1234',
      dayStartEquityMicros: '999999999999',
      peakEquityMicros: '999999999999',
    },
  }
  const captured = await Effect.runPromise(x.capture(Effect.succeed(used)))
  expect(captured.dailyTradedNotionalMicros).toBe('1234')
  expect(captured.inputs.dayStartEquityMicros).toBe('999999999999')
  expect(captured.inputs.peakEquityMicros).toBe('999999999999')
  expect(captured.inputs.portfolio.brokerState.accountingHash).toBe(x.pass.brokerState.accountingHash)
  expect(Schema.is(ControlStudyOpeningSchema)(captured)).toBeTrue()
})

test.each(['live account', 'other request', 'other build', 'changed policy', 'other authority'] as const)(
  'capture rejects %s before native reconciliation',
  async (fault) => {
    const x = fixture()
    if (fault === 'live account') x.runtime.broker = { ...x.runtime.broker, environment: BrokerEnvironment.Live }
    if (fault === 'other request') x.runtime.requestHash = sha256('other request')
    if (fault === 'other build') x.runtime.build = { ...x.runtime.build, sourceRevision: 'f'.repeat(40) }
    if (fault === 'changed policy') x.runtime.policy = { ...x.runtime.policy, maxDrawdownMicros: '1' }
    let reconciliations = 0
    const exit = await Effect.runPromiseExit(
      captureControlStudyOpening(x.plan, x.runtime, {
        readBoundGeneration: Effect.succeed(
          fault === 'other authority' ? sha256('other generation') : x.opening.inputs.authority.generationHash,
        ),
        reconcile: Effect.sync(() => {
          reconciliations++
          return x.pass
        }),
        now: Effect.succeed(x.opening.inputs.observedAt),
      }),
    )
    expect(exit._tag).toBe('Failure')
    expect(reconciliations).toBe(0)
  },
)

test('capture rejects an authority change during the native pass', async () => {
  const x = fixture()
  const changed = {
    ...x.pass,
    riskContext: {
      ...x.pass.riskContext,
      authority: { ...x.opening.inputs.authority, generationHash: sha256('other generation') },
      authorityObservedAt: x.opening.inputs.authorityObservedAt,
    },
  }
  const exit = await Effect.runPromiseExit(x.capture(Effect.succeed(changed)))
  expect(exit._tag).toBe('Failure')
})

test('failed native request-to-generation verification propagates before reconciliation', async () => {
  const x = fixture()
  let reconciliations = 0
  const result = await Effect.runPromise(
    captureControlStudyOpening(x.plan, x.runtime, {
      readBoundGeneration: Effect.fail('durable generation belongs to another request'),
      reconcile: Effect.sync(() => {
        reconciliations++
        return x.pass
      }),
      now: Effect.succeed(x.opening.inputs.observedAt),
    }).pipe(Effect.result),
  )
  expect(result).toEqual(Result.fail('durable generation belongs to another request'))
  expect(reconciliations).toBe(0)
})

test('private capture publishes its receipt last and an existing output prevents repeated reconciliation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bayn-native-opening-'))
  try {
    const x = fixture()
    const output = join(root, 'capture')
    let captures = 0
    const capture = x.capture(
      Effect.sync(() => {
        captures++
        return x.pass
      }),
    )
    const run = retainControlStudyOpening(output, sha256('plan bytes'), capture).pipe(
      Effect.provide(NodeServices.layer),
    )
    const result = await Effect.runPromise(run)
    const text = readFileSync(join(output, 'opening.json'), 'utf8')
    expect(result.openingSha256).toBe(sha256(text))
    expect(JSON.parse(text)).toEqual(x.opening)
    expect(JSON.parse(readFileSync(join(output, 'opening-receipt.json'), 'utf8'))).toMatchObject({
      planSha256: sha256('plan bytes'),
      openingSha256: sha256(text),
    })
    expect(statSync(output).mode & 0o777).toBe(0o700)
    expect(statSync(join(output, 'opening.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(output, 'opening-receipt.json')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(output, 'opening-receipt.json.tmp'))).toBeFalse()
    expect((await Effect.runPromiseExit(run))._tag).toBe('Failure')
    expect(captures).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(['failure', 'defect', 'interruption'] as const)(
  'a native %s closes the capture and cannot publish a receipt',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'bayn-native-opening-failure-'))
    try {
      const output = join(root, 'capture')
      let releases = 0
      const failure =
        kind === 'failure'
          ? Effect.fail('native reconciliation failed')
          : kind === 'defect'
            ? Effect.die('native defect')
            : Effect.interrupt
      const capture = Effect.scoped(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            releases++
          }),
        ).pipe(Effect.andThen(failure)),
      )
      const exit = await Effect.runPromiseExit(
        retainControlStudyOpening(output, sha256('plan bytes'), capture).pipe(Effect.provide(NodeServices.layer)),
      )
      expect(exit._tag).toBe('Failure')
      expect(releases).toBe(1)
      expect(existsSync(join(output, 'opening.json'))).toBeFalse()
      expect(existsSync(join(output, 'opening-receipt.json'))).toBeFalse()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('a capture deadline cancels stalled reconciliation and releases its scope without a receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bayn-native-opening-timeout-'))
  try {
    const output = join(root, 'capture')
    let releases = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const capture = Effect.scoped(
          Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
            Effect.sync(() => {
              releases++
            }),
          ).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.timeout('100 millis'))
        const fiber = yield* retainControlStudyOpening(output, sha256('plan bytes'), capture).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(100)
        expect((yield* Fiber.await(fiber))._tag).toBe('Failure')
      }).pipe(Effect.provide(NodeServices.layer), Effect.provide(TestClock.layer())),
    )
    expect(releases).toBe(1)
    expect(existsSync(join(output, 'opening-receipt.json'))).toBeFalse()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
