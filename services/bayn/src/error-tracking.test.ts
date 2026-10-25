import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import * as Sentry from '@sentry/node'
import { Cause, Effect, Exit } from 'effect'

import {
  initializeErrorTracking,
  reportReconciliationState,
  reportTerminalFailure,
  sanitizeErrorEvent,
} from './error-tracking'
import { DiscrepancyKind, ReconciliationStatus, type Reconciliation } from './execution/contracts'
import { CycleRunnerError } from './cycle/runner/model'
import { observePass } from './observe-composition/decision-builder'
import { makeNativeArrivalJournal } from './market-data/streaming/native-arrival-journal'
import { NativeArrivalCaptureError } from './market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from './market-data/streaming/native-arrival.test-support'

describe('GlitchTip error-only safety boundary', () => {
  afterAll(() => Sentry.close(0))

  test('disabled if DSN is missing', () => {
    expect(initializeErrorTracking('bayn', {})).toBe(false)
  })

  test('rejects dashed UUID keys instead of silently dropping events', () => {
    expect(() =>
      initializeErrorTracking('bayn', {
        BAYN_GLITCHTIP_DSN: 'http://591bd90b-e7b8-4b22-856e-c7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
      }),
    ).toThrow('invalid project key')
  })

  test('disables runtime tracing injection and flushes terminal failures before propagating them', async () => {
    initializeErrorTracking('bayn-test', {
      BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
    })
    expect(Sentry.getClient<Sentry.NodeClient>()?.getOptions().enableRuntimeChannelInjection).toBe(false)
    expect(Sentry.getClient<Sentry.NodeClient>()?.getOptions().enableOpenTelemetrySetup).toBe(false)
    const capture = spyOn(Sentry, 'captureException').mockReturnValue('a'.repeat(32))
    let releaseFlush: ((value: boolean) => void) | undefined
    const flush = spyOn(Sentry, 'flush').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFlush = resolve
        }),
    )
    const original = new Error('private runtime details')
    let completed = false
    try {
      const result = Effect.runPromiseExit(Effect.fail(original).pipe(reportTerminalFailure('bayn-test'))).then(
        (exit) => {
          completed = true
          return exit
        },
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(capture).toHaveBeenCalledTimes(1)
      expect(flush).toHaveBeenCalledWith(3_000)
      expect(completed).toBe(false)
      releaseFlush?.(true)
      const exit = await result
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original)
      await Effect.runPromiseExit(Effect.interrupt.pipe(reportTerminalFailure('bayn-test')))
      expect(capture).toHaveBeenCalledTimes(1)
      expect(flush).toHaveBeenCalledTimes(1)
    } finally {
      releaseFlush?.(true)
      capture.mockRestore()
      flush.mockRestore()
    }
  })

  test('reports a committed trading restriction once, including after restart, and reopens after recovery', () => {
    initializeErrorTracking('bayn-test', {
      BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
    })
    const capture = spyOn(Sentry, 'captureException').mockReturnValue('b'.repeat(32))
    const reconciliation: Reconciliation = {
      schemaVersion: 'bayn.paper-reconciliation.v1',
      reconciliationId: 'a'.repeat(64),
      accountId: 'private-account',
      expectedHash: 'b'.repeat(64),
      observedHash: 'c'.repeat(64),
      contentHash: 'd'.repeat(64),
      status: ReconciliationStatus.Discrepancy,
      reconciledAt: '2026-10-16T07:12:00.000Z',
      discrepancies: [
        {
          discrepancyId: 'e'.repeat(64),
          kind: DiscrepancyKind.Cash,
          identity: 'private-account',
          expected: '100005570000',
          observed: '100007970000',
          evidenceHash: 'f'.repeat(64),
          firstObservedAt: '2026-10-16T07:10:11.917Z',
          lastObservedAt: '2026-10-16T07:10:11.917Z',
        },
      ],
    }
    try {
      reportReconciliationState(reconciliation)
      reportReconciliationState({ ...reconciliation, reconciliationId: 'f'.repeat(64) })
      expect(capture).toHaveBeenCalledTimes(1)
      expect(capture.mock.calls[0]?.[0]).toMatchObject({ name: 'ReconciliationDiscrepancyError' })
      expect(JSON.stringify(capture.mock.calls)).not.toContain('private-account')
      expect(JSON.stringify(capture.mock.calls)).not.toContain('100007970000')
      reportReconciliationState({ ...reconciliation, status: ReconciliationStatus.Exact, discrepancies: [] })
      reportReconciliationState(reconciliation)
      expect(capture).toHaveBeenCalledTimes(2)
    } finally {
      reportReconciliationState({ ...reconciliation, status: ReconciliationStatus.Exact, discrepancies: [] })
      capture.mockRestore()
    }
  })

  test('an unavailable error collector preserves the original terminal failure', async () => {
    initializeErrorTracking('bayn-test', {
      BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
    })
    const capture = spyOn(Sentry, 'captureException').mockReturnValue('c'.repeat(32))
    const flush = spyOn(Sentry, 'flush').mockRejectedValue(new Error('collector unavailable'))
    const original = new Error('original application failure')
    try {
      const exit = await Effect.runPromiseExit(Effect.fail(original).pipe(reportTerminalFailure('bayn-test')))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original)
    } finally {
      capture.mockRestore()
      flush.mockRestore()
    }
  })

  test.each([false, true])(
    'a native capture write failure reaches GlitchTip without interrupting retention finalization when SDK throws=%s',
    async (sdkThrows) => {
      initializeErrorTracking('bayn-test', {
        BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
      })
      const capture = spyOn(Sentry, 'captureException').mockImplementation(() => {
        if (sdkThrows) throw new Error('synthetic collector failure')
        return 'f'.repeat(32)
      })
      const failure = new NativeArrivalCaptureError({
        message: 'private retention failure',
        cause: 'private input bytes',
      })
      let appends = 0
      let finalized = false
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const journal = yield* makeNativeArrivalJournal(
                epoch,
                {
                  begin: () => Effect.void,
                  append: () => Effect.suspend(() => (++appends === 1 ? Effect.fail(failure) : Effect.void)),
                  end: () =>
                    Effect.sync(() => {
                      finalized = true
                    }),
                },
                { chunkBytes: 1, queueBytes: 1_500 },
              )
              yield* journal.observe(observation(1))
              for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
              expect(journal.status().status).toBe('INCOMPLETE')
            }),
          ),
        )
        expect(capture).toHaveBeenCalledTimes(1)
        expect(capture.mock.calls[0]?.[0]).toBe(failure)
        expect(finalized).toBe(true)
      } finally {
        capture.mockRestore()
      }
    },
  )

  test('redacts potentially sensitive exception data but retains frames', () => {
    const event = sanitizeErrorEvent({
      type: undefined,
      message: 'broker account=secret',
      user: { id: 'customer-id' },
      request: { url: 'https://secret.example/?token=private' },
      breadcrumbs: [{ message: 'broker credentials here' }],
      extra: { account: 'private' },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'broker key is private',
            stacktrace: {
              frames: [
                {
                  filename: 'strategy.ts',
                  lineno: 31,
                  function: 'evaluate',
                  vars: { key: 'secret' },
                  context_line: 'key=secret',
                },
              ],
            },
          },
        ],
      },
    })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('customer-id')
    expect(event.message).toBe('Bayn application exception')
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.function).toBe('evaluate')
  })

  test('reports a handled failed pass before projecting it without losing its typed outcome', async () => {
    const error = new CycleRunnerError({
      operation: 'run-cycle-pass',
      failure: 'operational',
      message: 'private runtime details',
    })
    let tags: Readonly<Record<string, unknown>> | undefined
    const capture = spyOn(Sentry, 'captureException').mockImplementation(() => {
      tags = Sentry.getCurrentScope().getScopeData().tags
      return 'd'.repeat(32)
    })
    try {
      const retained = await Effect.runPromise(
        observePass(() => Effect.sync(() => expect(capture).toHaveBeenCalledTimes(1)), {
          outcome: 'FAILED',
          observedAt: '2026-10-18T01:11:07.126Z',
          error,
        }),
      )
      expect(capture).toHaveBeenCalledWith(error)
      expect(tags).toMatchObject({
        service: 'bayn-test',
        stage: 'bayn.execution.cycle-pass',
        operation: 'run-cycle-pass',
        failure: 'operational',
      })
      expect(JSON.stringify(tags)).not.toContain('private runtime details')
      expect(retained).toMatchObject({ result: 'FAILURE', operation: error.operation, failure: error.failure })
    } finally {
      capture.mockRestore()
    }
  })

  test('broker observation waits and successful passes do not create GlitchTip issues', async () => {
    const capture = spyOn(Sentry, 'captureException').mockReturnValue('e'.repeat(32))
    try {
      await Effect.runPromise(
        observePass(() => Effect.void, {
          outcome: 'WAITING',
          observedAt: '2026-10-18T01:11:07.126Z',
          waitReason: 'BROKER_OBSERVATION_PENDING',
        }),
      )
      await Effect.runPromise(
        observePass(() => Effect.void, {
          outcome: 'SUCCEEDED',
          observedAt: '2026-10-18T01:11:07.126Z',
          result: { outcome: 'WINDOW_CLOSED', observedAt: '2026-10-18T01:11:07.126Z' },
        }),
      )
      expect(capture).not.toHaveBeenCalled()
    } finally {
      capture.mockRestore()
    }
  })

  test('an error-reporting failure cannot replace the durable failed pass', async () => {
    const capture = spyOn(Sentry, 'captureException').mockImplementation(() => {
      throw new Error('collector adapter unavailable')
    })
    const error = new CycleRunnerError({
      operation: 'reconcile',
      failure: 'database',
      message: 'original pass failure',
    })
    try {
      const retained = await Effect.runPromise(
        observePass(() => Effect.void, { outcome: 'FAILED', observedAt: '2026-10-18T01:11:07.126Z', error }),
      )
      expect(capture).toHaveBeenCalledTimes(1)
      expect(retained).toMatchObject({ result: 'FAILURE', operation: error.operation, failure: error.failure })
    } finally {
      capture.mockRestore()
    }
  })
})
