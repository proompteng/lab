import { expect, test } from 'bun:test'
import { Effect, Exit, Fiber } from 'effect'

import { WorkflowActivationRuntime, WorkflowMailbox } from '../../src/workflow/activation'

const settle = async () => {}

test('mailboxes suspend, deliver a batch in order, and unregister interrupted consumers', async () => {
  const runtime = new WorkflowActivationRuntime()
  const mailbox = new WorkflowMailbox<string>()
  try {
    const cancelled = runtime.fork(mailbox.take('signal'))
    await runtime.drain(settle)
    expect(cancelled.unsafePoll()).toBeNull()
    runtime.fork(Fiber.interrupt(cancelled))
    await runtime.drain(settle)
    expect(cancelled.unsafePoll()?._tag).toBe('Failure')

    const batch = runtime.fork(mailbox.takeAll('signal'))
    await runtime.drain(settle)
    mailbox.deliver('signal', 'first')
    mailbox.deliver('signal', 'second')
    await runtime.drain(settle)
    expect(batch.unsafePoll()).toEqual(Exit.succeed(['first', 'second']))

    const next = runtime.fork(mailbox.take('signal'))
    await runtime.drain(settle)
    expect(next.unsafePoll()).toBeNull()
    mailbox.deliver('signal', 'third')
    await runtime.drain(settle)
    expect(next.unsafePoll()).toEqual(Exit.succeed('third'))
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
  const unrelated = Effect.runFork(Effect.async<never>(() => undefined))
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
        const child = yield* Effect.forkDaemon(waiting)
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
    expect(Fiber.unsafeRoots(undefined)).toContain(unrelated)
    let retained = references.length
    for (let attempt = 0; attempt < 10 && retained > 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      Bun.gc(true)
      retained = references.filter((reference) => reference.deref() !== undefined).length
    }
    expect(retained).toBe(0)
    expect(finalized).toBe(0)
    expect(unrelated.unsafePoll()).toBeNull()
  } finally {
    await Effect.runPromise(Fiber.interrupt(unrelated))
  }
})
