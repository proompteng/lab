import { describe, expect, test } from 'bun:test'
import { createServer as createNodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Data, Effect, Exit, Fiber } from 'effect'

import type { LifecycleCommandStoreShape } from './db/lifecycle-command'
import type { WriterFenceService } from './execution/writer-fence'
import { executeLifecycleCommand, type LifecycleCommandAdvance, serveLifecycleCommands } from './lifecycle-command-http'
import { lifecycleCommandId } from './lifecycle-command-contract'

const command = {
  controllerKey: 'primary',
  commandId: 'a'.repeat(64),
  sequence: 1,
  issuedAt: '2026-08-10T20:00:00.000Z',
}

const observation = {
  result: 'SUCCESS' as const,
  outcome: 'NOT_DUE' as const,
  observedAt: '2026-08-10T20:00:01.000Z',
}

const lifecycleToken = 'projected-lifecycle-token'
const lifecycleAuthorization = { authorization: `Bearer ${lifecycleToken}` }
const authenticateLifecycle = (token: string) => Effect.succeed(token === lifecycleToken)

const makeFence = (transactions: string[]): WriterFenceService => {
  const transaction: WriterFenceService['transaction'] = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.sync(() => transactions.push('transaction')).pipe(Effect.andThen(effect))
  return { backendPid: 7, check: Effect.void, transaction }
}

class AdvanceFailure extends Data.TaggedError('AdvanceFailure')<{}> {}

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNodeServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      server.close((cause) => (cause === undefined ? resolve(address.port) : reject(cause)))
    })
  })

const waitForServer = async (origin: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/livez`, { signal: AbortSignal.timeout(100) })
      if (response.ok) return
    } catch {
      // The scoped server fiber may not have bound its socket yet.
    }
    await Bun.sleep(10)
  }
  throw new Error('lifecycle command server did not listen')
}

describe('Bayn lifecycle command execution', () => {
  test('durably begins, advances once, and completes a fresh command under the writer fence', async () => {
    const calls: string[] = []
    const store: LifecycleCommandStoreShape = {
      readCursor: () => Effect.die(new Error('cursor is outside this boundary')),
      begin: (input) =>
        Effect.sync(() => {
          calls.push(`begin:${input.sequence}`)
          return { _tag: 'Execute' as const }
        }),
      complete: (input) =>
        Effect.sync(() => {
          calls.push(`complete:${input.sequence}`)
          expect(input.observation).toEqual(observation)
          return input.observation
        }),
    }

    const receipt = await Effect.runPromise(
      executeLifecycleCommand(
        store,
        makeFence(calls),
        command,
        Effect.sync(() => {
          calls.push('advance')
          return { observation }
        }),
      ),
    )

    expect(receipt).toEqual({ observation, replayed: false })
    expect(calls).toEqual(['transaction', 'begin:1', 'advance', 'transaction', 'complete:1'])
  })

  test('replays a completed receipt without advancing the lifecycle again', async () => {
    const calls: string[] = []
    const store: LifecycleCommandStoreShape = {
      readCursor: () => Effect.die(new Error('cursor is outside this boundary')),
      begin: () => Effect.succeed({ _tag: 'Completed', observation }),
      complete: () => Effect.die(new Error('completed commands must not be completed twice')),
    }

    const receipt = await Effect.runPromise(
      executeLifecycleCommand(
        store,
        makeFence(calls),
        command,
        Effect.die(new Error('completed commands must not advance twice')),
      ),
    )

    expect(receipt).toEqual({ observation, replayed: true })
    expect(calls).toEqual(['transaction'])
  })

  test('leaves a started command incomplete when the one-pass interpreter fails', async () => {
    const calls: string[] = []
    const store: LifecycleCommandStoreShape = {
      readCursor: () => Effect.die(new Error('cursor is outside this boundary')),
      begin: () => Effect.succeed({ _tag: 'Execute' }),
      complete: () =>
        Effect.sync(() => {
          calls.push('complete')
          return observation
        }),
    }

    const exit = await Effect.runPromiseExit(
      executeLifecycleCommand(store, makeFence(calls), command, Effect.fail(new AdvanceFailure())),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual(['transaction'])
  })

  test('accepts only current and one prior rollout revision before advancing an exact bound command', async () => {
    const port = await reservePort()
    const sourceRevision = 'a'.repeat(40)
    const calls: Array<{ readonly operation: string; readonly input: unknown }> = []
    const store: LifecycleCommandStoreShape = {
      readCursor: () => Effect.succeed({ _tag: 'Next', sequence: 1 }),
      begin: (input) =>
        Effect.sync(() => {
          calls.push({ operation: 'begin', input })
          return { _tag: 'Execute' as const }
        }),
      complete: (input) =>
        Effect.sync(() => {
          calls.push({ operation: 'complete', input })
          return input.observation
        }),
    }
    const advance = Effect.sync(() => {
      calls.push({ operation: 'advance', input: null })
      return { observation }
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* serveLifecycleCommands(
            {
              host: '127.0.0.1',
              port,
              controllerKey: 'primary',
              sourceRevision,
              previousSourceRevision: 'b'.repeat(40),
              nextDelayMs: 30_000,
            },
            store,
            makeFence([]),
            authenticateLifecycle,
            advance,
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          const origin = `http://127.0.0.1:${port}`
          yield* Effect.promise(() => waitForServer(origin))

          const unauthenticated = yield* Effect.promise(() => fetch(`${origin}/v1/lifecycle/cursor`))
          expect(unauthenticated.status).toBe(401)
          const unauthenticatedBody = yield* Effect.promise(() => unauthenticated.json())
          expect(unauthenticatedBody).toEqual({ accepted: false, reason: 'AUTHENTICATION_REQUIRED' })

          const forged = yield* Effect.promise(() =>
            fetch(`${origin}/v1/lifecycle/cursor`, { headers: { authorization: 'Bearer forged-token' } }),
          )
          expect(forged.status).toBe(403)
          const forgedBody = yield* Effect.promise(() => forged.json())
          expect(forgedBody).toEqual({ accepted: false, reason: 'AUTHENTICATION_REJECTED' })
          expect(calls).toEqual([])

          const cursor = yield* Effect.promise(() =>
            fetch(`${origin}/v1/lifecycle/cursor`, { headers: lifecycleAuthorization }).then((response) =>
              response.json(),
            ),
          )
          expect(cursor).toEqual({
            schemaVersion: 'bayn.lifecycle-command-cursor.v1',
            controllerKey: 'primary',
            sourceRevision,
            cursor: { _tag: 'Next', sequence: 1 },
          })

          const request = {
            schemaVersion: 'bayn.lifecycle-command.v1',
            controllerKey: 'primary',
            commandId: lifecycleCommandId('primary', 1),
            sequence: 1,
            issuedAt: command.issuedAt,
          } as const
          const mismatched = yield* Effect.promise(() =>
            fetch(`${origin}/v1/lifecycle/advance`, {
              method: 'POST',
              headers: { ...lifecycleAuthorization, 'content-type': 'application/json' },
              body: JSON.stringify({ ...request, sourceRevision: 'c'.repeat(40) }),
            }),
          )
          expect(mismatched.status).toBe(503)
          const mismatchedBody = yield* Effect.promise(() => mismatched.json())
          expect(mismatchedBody).toEqual({ accepted: false, reason: 'SOURCE_REVISION_MISMATCH' })
          expect(calls).toEqual([])

          const accepted = yield* Effect.promise(() =>
            fetch(`${origin}/v1/lifecycle/advance`, {
              method: 'POST',
              headers: { ...lifecycleAuthorization, 'content-type': 'application/json' },
              body: JSON.stringify({ ...request, sourceRevision: 'b'.repeat(40) }),
            }),
          )
          expect(accepted.status).toBe(200)
          const acceptedBody = yield* Effect.promise(() => accepted.json())
          expect(acceptedBody).toEqual({
            schemaVersion: 'bayn.lifecycle-command-response.v1',
            accepted: true,
            commandId: request.commandId,
            sequence: 1,
            sourceRevision: 'b'.repeat(40),
            replayed: false,
            nextDelayMs: 30_000,
            observation,
          })
          expect(calls.map(({ operation }) => operation)).toEqual(['begin', 'advance', 'complete'])
          expect(calls[0]?.input).toEqual({
            controllerKey: 'primary',
            commandId: request.commandId,
            sequence: 1,
            issuedAt: command.issuedAt,
          })
        }),
      ),
    )
  }, 10_000)

  test('serializes a timed-out command and its retry so the one-pass interpreter advances once', async () => {
    const port = await reservePort()
    const sourceRevision = 'a'.repeat(40)
    let completed = false
    let advanceCount = 0
    let releaseAdvance: (() => void) | undefined
    const store: LifecycleCommandStoreShape = {
      readCursor: () => Effect.succeed({ _tag: 'Next', sequence: 1 }),
      begin: () => Effect.sync(() => (completed ? { _tag: 'Completed', observation } : { _tag: 'Execute' })),
      complete: (input) =>
        Effect.sync(() => {
          completed = true
          return input.observation
        }),
    }
    const request = {
      schemaVersion: 'bayn.lifecycle-command.v1',
      controllerKey: 'primary',
      commandId: lifecycleCommandId('primary', 1),
      sequence: 1,
      issuedAt: command.issuedAt,
      sourceRevision,
    } as const

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* serveLifecycleCommands(
            {
              host: '127.0.0.1',
              port,
              controllerKey: 'primary',
              sourceRevision,
              previousSourceRevision: undefined,
              nextDelayMs: 30_000,
            },
            store,
            makeFence([]),
            authenticateLifecycle,
            Effect.callback<LifecycleCommandAdvance>((resume) => {
              advanceCount += 1
              releaseAdvance = () => resume(Effect.succeed({ observation }))
            }),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          const origin = `http://127.0.0.1:${port}`
          yield* Effect.promise(() => waitForServer(origin))

          const send = () =>
            fetch(`${origin}/v1/lifecycle/advance`, {
              method: 'POST',
              headers: { ...lifecycleAuthorization, 'content-type': 'application/json' },
              body: JSON.stringify(request),
            })
          const first = send()
          while (advanceCount === 0) yield* Effect.sleep('1 millis')
          const retry = send()
          yield* Effect.sleep('10 millis')
          expect(advanceCount).toBe(1)
          releaseAdvance?.()

          const responses = yield* Effect.promise(() => Promise.all([first, retry]))
          const bodies = yield* Effect.promise(() => Promise.all(responses.map((response) => response.json())))
          expect(responses.map((response) => response.status)).toEqual([200, 200])
          expect(advanceCount).toBe(1)
          expect(bodies.map((body) => body.replayed)).toEqual([false, true])
        }),
      ),
    )
  }, 10_000)

  test('interrupts and joins an in-flight command before closing the server', async () => {
    const port = await reservePort()
    const sourceRevision = 'a'.repeat(40)
    let releaseStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })
    let interrupted = false
    let completed = false
    const store: LifecycleCommandStoreShape = {
      readCursor: () => Effect.succeed({ _tag: 'Next', sequence: 1 }),
      begin: () => Effect.succeed({ _tag: 'Execute' }),
      complete: () =>
        Effect.sync(() => {
          completed = true
          return observation
        }),
    }
    const advance = Effect.callback<LifecycleCommandAdvance>((_resume) => {
      releaseStarted?.()
      return Effect.sync(() => {
        interrupted = true
      })
    })
    const request = {
      schemaVersion: 'bayn.lifecycle-command.v1',
      controllerKey: 'primary',
      commandId: lifecycleCommandId('primary', 1),
      sequence: 1,
      issuedAt: command.issuedAt,
      sourceRevision,
    } as const

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const serverFiber = yield* serveLifecycleCommands(
            {
              host: '127.0.0.1',
              port,
              controllerKey: 'primary',
              sourceRevision,
              previousSourceRevision: undefined,
              nextDelayMs: 30_000,
            },
            store,
            makeFence([]),
            authenticateLifecycle,
            advance,
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          const origin = `http://127.0.0.1:${port}`
          yield* Effect.promise(() => waitForServer(origin))
          const pendingRequest = fetch(`${origin}/v1/lifecycle/advance`, {
            method: 'POST',
            headers: { ...lifecycleAuthorization, 'content-type': 'application/json' },
            body: JSON.stringify(request),
          }).then(
            () => 'response' as const,
            () => 'closed' as const,
          )
          const startOutcome = yield* Effect.promise(() =>
            Promise.race([started.then(() => 'started' as const), Bun.sleep(1_000).then(() => 'timeout' as const)]),
          )
          expect(startOutcome).toBe('started')

          yield* Fiber.interrupt(serverFiber)

          const requestOutcome = yield* Effect.promise(() =>
            Promise.race([pendingRequest, Bun.sleep(1_000).then(() => 'timeout' as const)]),
          )
          expect(requestOutcome).toBe('closed')
          expect(interrupted).toBe(true)
          expect(completed).toBe(false)
        }),
      ),
    )
  }, 10_000)
})
