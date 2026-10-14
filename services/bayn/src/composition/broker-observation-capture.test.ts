import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { BrokerAccountPreflightError } from '../broker/alpaca/preflight'
import { BrokerSessionAcquisitionError, BrokerSessionAcquisitionStage } from '../broker/alpaca/session'
import { runBrokerObservationCapture } from './broker-observation-runtime'

const readFailure = new BrokerReadError({
  operation: 'positions',
  kind: BrokerReadErrorKind.InvalidResponse,
  retryable: false,
  message: 'Alpaca positions response body does not match its schema',
  cause: { private: 'not for telemetry' },
})
const acquisitionFailure = new BrokerSessionAcquisitionError({
  stage: BrokerSessionAcquisitionStage.ReadSurface,
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  baseUrl: 'https://paper-api.alpaca.markets',
  expectedAccountId: 'private-account',
  cause: readFailure,
})

test('native lazy layer failure keeps INVALID_RESPONSE rather than inventing a timeout', async () => {
  const runtime = ManagedRuntime.make(Layer.effectDiscard(Effect.fail(acquisitionFailure)))
  try {
    const exit = await Effect.runPromiseExit(
      runBrokerObservationCapture((signal) => runtime.runPromiseExit(Effect.succeed('unused'), { signal })),
    )
    if (Exit.isSuccess(exit)) throw new Error('Expected failure')
    const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(failure).toMatchObject({
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
    expect(failure.cause).toBe(acquisitionFailure)
    expect(failure.message).not.toContain('private')
  } finally {
    await runtime.dispose()
  }
})

test('typed capture errors and genuine timeouts retain their original identity', async () => {
  const timeout = new BrokerReadError({
    operation: 'preflight',
    kind: BrokerReadErrorKind.Timeout,
    retryable: true,
    message: 'capture deadline',
  })
  for (const failure of [readFailure, timeout]) {
    const exit = await Effect.runPromiseExit(runBrokerObservationCapture(() => Promise.resolve(Exit.fail(failure))))
    if (Exit.isSuccess(exit)) throw new Error('Expected failure')
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(failure)
  }
})

test('success, defects and interruption cross the runtime boundary without operational relabeling', async () => {
  expect(await Effect.runPromise(runBrokerObservationCapture(() => Promise.resolve(Exit.succeed('captured'))))).toBe(
    'captured',
  )
  const defect = new Error('private defect')
  const exit = await Effect.runPromiseExit(runBrokerObservationCapture(() => Promise.resolve(Exit.die(defect))))
  if (Exit.isSuccess(exit)) throw new Error('Expected defect')
  expect(Cause.hasDies(exit.cause)).toBe(true)
  expect(Cause.findErrorOption(exit.cause)).toEqual(Option.none())
  const interrupted = await Effect.runPromiseExit(runBrokerObservationCapture(() => Promise.resolve(Exit.interrupt())))
  if (Exit.isSuccess(interrupted)) throw new Error('Expected interruption')
  expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
})

test('permission rejection remains fail-closed and is not classified as a timeout', async () => {
  const identity = {
    provider: acquisitionFailure.provider,
    environment: acquisitionFailure.environment,
    baseUrl: acquisitionFailure.baseUrl,
    expectedAccountId: acquisitionFailure.expectedAccountId,
  }
  const permission = new BrokerAccountPreflightError({
    ...identity,
    failure: { _tag: 'BrokerAccountBlocked' },
  })
  const acquisition = new BrokerSessionAcquisitionError({
    ...identity,
    stage: BrokerSessionAcquisitionStage.Permissions,
    cause: permission,
  })
  const exit = await Effect.runPromiseExit(runBrokerObservationCapture(() => Promise.resolve(Exit.fail(acquisition))))
  if (Exit.isSuccess(exit)) throw new Error('Expected rejection')
  expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
    operation: 'preflight',
    kind: BrokerReadErrorKind.Forbidden,
    retryable: false,
    cause: acquisition,
  })
})

test('parent cancellation reaches the managed capture and finalizes exactly once', async () => {
  const runtime = ManagedRuntime.make(Layer.empty)
  const started = Promise.withResolvers<void>()
  let finalized = 0
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    runBrokerObservationCapture((signal) =>
      runtime.runPromiseExit(
        Effect.sync(() => started.resolve()).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized += 1
            }),
          ),
        ),
        { signal },
      ),
    ),
    { signal: controller.signal },
  )
  await started.promise
  controller.abort()
  const exit = await pending
  await runtime.dispose()
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(finalized).toBe(1)
})

test('the capture deadline cancels the managed operation and preserves the deadline error', async () => {
  const runtime = ManagedRuntime.make(Layer.empty)
  const started = Promise.withResolvers<void>()
  let finalized = 0
  const timeout = new BrokerReadError({
    operation: 'preflight',
    kind: BrokerReadErrorKind.Timeout,
    retryable: true,
    message: 'capture deadline',
  })
  try {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const capture = runBrokerObservationCapture((signal) =>
          runtime.runPromiseExit(
            Effect.sync(() => started.resolve()).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized += 1
                }),
              ),
            ),
            { signal },
          ),
        )
        const fiber = yield* capture.pipe(
          Effect.timeoutOrElse({ duration: 1_000, orElse: () => Effect.fail(timeout) }),
          Effect.forkChild,
        )
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust(1_000)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    if (Exit.isSuccess(exit)) throw new Error('Expected deadline')
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(timeout)
  } finally {
    await runtime.dispose()
  }
  expect(finalized).toBe(1)
})
