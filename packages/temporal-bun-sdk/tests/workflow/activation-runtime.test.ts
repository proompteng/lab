import { expect, test } from 'bun:test'
import { releaseWeakRefs } from 'bun:jsc'
import { Effect, Exit, Fiber } from 'effect'

import { WorkflowActivationRuntime, WorkflowMailbox } from '../../src/workflow/activation'

const settle = async () => {}

test('workflow code and callback continuations run only during an activation drain', async () => {
  const runtime = new WorkflowActivationRuntime()
  const events: string[] = []
  let resume: ((effect: Effect.Effect<string>) => void) | undefined
  const fiber = runtime.fork(
    Effect.gen(function* () {
      events.push('started')
      const value = yield* Effect.callback<string>((callback) => {
        resume = callback
      })
      events.push(value)
      return value
    }),
  )
  expect(events).toEqual([])
  await runtime.drain(settle)
  expect(events).toEqual(['started'])
  resume!(Effect.succeed('delivered'))
  expect(events).toEqual(['started'])
  expect(fiber.pollUnsafe()).toBeUndefined()
  await runtime.drain(settle)
  expect(events).toEqual(['started', 'delivered'])
  expect(fiber.pollUnsafe()).toEqual(Exit.succeed('delivered'))
  runtime.dispose()
})

test('a late arbitrary callback cannot continue or finalize a discarded workflow', async () => {
  const runtime = new WorkflowActivationRuntime()
  let resume: ((effect: Effect.Effect<void>) => void) | undefined
  let continued = false
  let finalized = false
  const fiber = runtime.fork(
    Effect.callback<void>((callback) => {
      resume = callback
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          continued = true
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          finalized = true
        }),
      ),
    ),
  )
  await runtime.drain(settle)
  runtime.dispose()
  resume!(Effect.void)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(fiber.pollUnsafe()).toBeUndefined()
  expect({ continued, finalized }).toEqual({ continued: false, finalized: false })
})

test('mailboxes suspend, deliver a batch in order, and unregister interrupted consumers', async () => {
  const runtime = new WorkflowActivationRuntime()
  const mailbox = new WorkflowMailbox<string>()
  try {
    const cancelled = runtime.fork(mailbox.take('signal'))
    await runtime.drain(settle)
    expect(cancelled.pollUnsafe()).toBeUndefined()
    runtime.fork(Fiber.interrupt(cancelled))
    await runtime.drain(settle)
    expect(cancelled.pollUnsafe()?._tag).toBe('Failure')

    const batch = runtime.fork(mailbox.takeAll('signal'))
    await runtime.drain(settle)
    mailbox.deliver('signal', 'first')
    mailbox.deliver('signal', 'second')
    await runtime.drain(settle)
    expect(batch.pollUnsafe()).toEqual(Exit.succeed(['first', 'second']))

    const next = runtime.fork(mailbox.take('signal'))
    await runtime.drain(settle)
    expect(next.pollUnsafe()).toBeUndefined()
    mailbox.deliver('signal', 'third')
    await runtime.drain(settle)
    expect(next.pollUnsafe()).toEqual(Exit.succeed('third'))
  } finally {
    runtime.dispose()
  }
})

test('real Effect interruption runs finalizers while task disposal does not', async () => {
  const runtime = new WorkflowActivationRuntime()
  const mailbox = new WorkflowMailbox<void>()
  let finalized = 0
  const waiting = mailbox.take('activity').pipe(
    Effect.ensuring(
      Effect.sync(() => {
        finalized += 1
      }),
    ),
  )
  try {
    const interrupted = runtime.fork(waiting)
    await runtime.drain(settle)
    runtime.fork(Fiber.interrupt(interrupted))
    await runtime.drain(settle)
    expect(finalized).toBe(1)
    runtime.fork(waiting)
    await runtime.drain(settle)
  } finally {
    runtime.dispose()
  }
  mailbox.deliver('activity', undefined)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(finalized).toBe(1)
  expect(() => runtime.fork(Effect.void)).toThrow('disposed')
})

test('discarded durable fibers and daemon children are collectible without touching other Effect roots', async () => {
  const unrelated = Effect.runFork(Effect.callback<never>(() => undefined))
  let finalized = 0
  const references: WeakRef<object>[] = []
  const discard = async () => {
    const runtime = new WorkflowActivationRuntime()
    const mailbox = new WorkflowMailbox<void>()
    const waiting = mailbox.take('activity').pipe(
      Effect.uninterruptible,
      Effect.ensuring(
        Effect.sync(() => {
          finalized += 1
        }),
      ),
    )
    const parent = runtime.fork(
      Effect.gen(function* () {
        const child = yield* Effect.forkDetach(waiting)
        references.push(new WeakRef(child))
        yield* waiting
      }),
    )
    references.push(new WeakRef(parent))
    await runtime.drain(settle)
    runtime.dispose()
  }
  try {
    for (let index = 0; index < 20; index += 1) await discard()
    expect(unrelated.pollUnsafe()).toBeUndefined()
    let retained = references.length
    for (let attempt = 0; attempt < 10 && retained > 0; attempt += 1) {
      // Collect on a fresh callback stack; deref() also protects targets within a job.
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          releaseWeakRefs()
          Bun.gc(true)
          resolve()
        }),
      )
      retained = references.filter((reference) => reference.deref() !== undefined).length
    }
    expect(retained).toBe(0)
    expect(finalized).toBe(0)
    expect(unrelated.pollUnsafe()).toBeUndefined()
  } finally {
    await Effect.runPromise(Fiber.interrupt(unrelated))
  }
})
