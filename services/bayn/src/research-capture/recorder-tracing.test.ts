import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Option, Tracer } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { CaptureInvalidation, ResearchCaptureFailure, type ResearchCaptureBytes } from './capture'
import { captureEvent } from './capture.test-support'
import type { ResearchCaptureObject } from './export'
import { makeResearchCaptureRecorder, type ResearchCaptureStore } from './recorder'
import { sessionConfig, sessionStart } from './session.test-support'

const options = {
  captureId: 'private-capture-identity',
  sourceRevision: 'a'.repeat(40),
  maximumQueuedReceipts: 1024,
  maximumQueuedBytes: 4 * 1024 * 1024,
  maximumReceiptBytes: 64 * 1024,
  flushIntervalMs: 50,
  writeTimeoutMs: 1000,
}
const fixture = () => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({
    span: (input) => {
      const span = new Tracer.NativeSpan(input)
      spans.push(span)
      return span
    },
  })
  const chunks: ResearchCaptureBytes[] = []
  const seals: ResearchCaptureBytes[] = []
  const store: ResearchCaptureStore = {
    append: (bytes) =>
      Effect.sync(() => {
        chunks.push(bytes)
      }),
    seal: (bytes) =>
      Effect.sync(() => {
        seals.push(bytes)
      }),
  }
  return { spans, tracer, chunks, seals, store }
}
const run = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>, tracer: Tracer.Tracer) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer()), Effect.provideService(Tracer.Tracer, tracer)),
  )
const parent = (span: Tracer.NativeSpan) => Option.getOrUndefined(span.parent)?.spanId
const events = (span: Tracer.NativeSpan) => span.events.map(([name]) => name)

test('a session claim retains SQL-before-object ordering and its own persistence span', async () => {
  const saved = fixture()
  const order: string[] = []
  const { captureId: _id, sessionDate: _date, calendar: _calendar, ...session } = sessionConfig
  await run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sessionStart)
      const recorder = yield* makeResearchCaptureRecorder(
        {
          ...saved.store,
          append: (bytes) =>
            Effect.sync(() => {
              order.push('append')
            }).pipe(Effect.andThen(saved.store.append(bytes))),
        },
        {
          ...options,
          maximumObjectBytes: session.maximumObjectBytes,
          maximumSqlBytes: session.maximumSqlBytes,
          session,
        },
        {
          putVerified: () =>
            Effect.sync(() => {
              order.push('put', 'get')
            }).pipe(Effect.withSpan('fixture.object')),
        },
      )
      expect(order).toEqual(['append', 'put', 'get'])
      const claim = saved.spans.find((span) => span.name === 'bayn.capture.persistence')
      if (claim === undefined) throw new Error('Missing claim span')
      expect(claim.attributes.get('bayn.capture.persistence.operation')).toBe('CLAIM')
      expect(claim.attributes.get('bayn.capture.chunk.ordinal')).toBe(0)
      expect(claim.attributes.get('bayn.capture.metadata.sha256')).toBe(saved.chunks[0]?.contentHash)
      expect((yield* recorder.status).invalidations).toEqual([])
      yield* recorder.finish
    }),
    saved.tracer,
  )
})

test('capture operation spans correlate object verification and SQL without changing exact durable bytes', async () => {
  const saved = fixture()
  const objects: ResearchCaptureObject[] = []
  const order: string[] = []
  await run(
    Effect.gen(function* () {
      const recorder = yield* makeResearchCaptureRecorder(
        {
          append: (bytes) =>
            Effect.sync(() => {
              order.push('append')
            }).pipe(Effect.andThen(saved.store.append(bytes))),
          seal: (bytes) =>
            Effect.sync(() => {
              order.push('seal')
            }).pipe(Effect.andThen(saved.store.seal(bytes))),
        },
        options,
        {
          putVerified: (object) =>
            Effect.sync(() => {
              objects.push(object)
              order.push('put', 'get')
            }).pipe(Effect.withSpan('fixture.object')),
        },
      )
      recorder.record(captureEvent('STARTED'), 0)
      recorder.record(captureEvent('STOPPED'), 0)
      const seal = yield* recorder.finish
      expect(seal?.invalidations).toEqual([])
    }),
    saved.tracer,
  )
  expect(order).toEqual(['put', 'get', 'append', 'put', 'get', 'put', 'get', 'seal'])
  const operations = saved.spans.filter((span) => span.name === 'bayn.capture.persistence')
  const sql = saved.spans.filter((span) => span.name === 'bayn.capture.sql')
  expect(operations.map((span) => span.attributes.get('bayn.capture.persistence.operation'))).toEqual(['CHUNK', 'SEAL'])
  expect(sql).toHaveLength(2)
  for (const [index, span] of operations.entries()) {
    expect(events(span)).toEqual([
      'bayn.capture.persistence.started',
      'bayn.capture.persistence.io_completed',
      'bayn.capture.persistence.cleanup_finished',
    ])
    expect(span.attributes.get('bayn.capture.metadata.sha256')).toBe(
      (index === 0 ? saved.chunks : saved.seals)[0]?.contentHash,
    )
    const sqlSpan = sql[index]
    if (sqlSpan === undefined) throw new Error('Missing SQL child span')
    expect(parent(sqlSpan)).toBe(span.spanId)
    expect(events(sqlSpan)).toEqual(['bayn.capture.sql.started', 'bayn.capture.sql.acknowledged'])
    expect(
      saved.spans.filter((child) => child.name === 'fixture.object' && parent(child) === span.spanId),
    ).toHaveLength(index === 0 ? 1 : 2)
  }
  const untraced = fixture()
  const untracedObjects: ResearchCaptureObject[] = []
  await run(
    Effect.gen(function* () {
      const recorder = yield* makeResearchCaptureRecorder(untraced.store, options, {
        putVerified: (object) =>
          Effect.sync(() => {
            untracedObjects.push(object)
          }),
      })
      recorder.record(captureEvent('STARTED'), 0)
      recorder.record(captureEvent('STOPPED'), 0)
      yield* recorder.finish
    }).pipe(Effect.withTracerEnabled(false)),
    untraced.tracer,
  )
  expect(untraced.chunks).toEqual(saved.chunks)
  expect(untraced.seals).toEqual(saved.seals)
  expect(untracedObjects.toSorted((a, b) => a.contentHash.localeCompare(b.contentHash))).toEqual(
    objects.toSorted((a, b) => a.contentHash.localeCompare(b.contentHash)),
  )
})

test.each([false, true])(
  'capture deadline is visible at one second before eight-second SQL cleanup (raw=%s)',
  async (raw) => {
    const saved = fixture()
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            append: (bytes) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                yield* saved.store.append(bytes)
              }).pipe(Effect.uninterruptible),
          },
          options,
          raw ? { putVerified: () => Effect.void } : undefined,
        )
        recorder.record(captureEvent('STARTED'), 0)
        yield* TestClock.adjust(50)
        yield* Deferred.await(entered)
        yield* TestClock.adjust(1000)
        const operation = saved.spans.find((span) => span.name === 'bayn.capture.persistence')
        if (operation === undefined) throw new Error('Missing persistence span')
        expect(operation.events.find(([name]) => name === 'bayn.capture.persistence.deadline_expired')?.[1]).toBe(
          1_050_000_000n,
        )
        expect(events(operation)).not.toContain('bayn.capture.persistence.cleanup_finished')
        const before = yield* recorder.status
        recorder.record(captureEvent('STOPPED'), 1050)
        const after = yield* recorder.status
        expect(after.retainedPayloadBytes).toBe(before.retainedPayloadBytes)
        expect(after.retainedReceipts).toBe(before.retainedReceipts)
        expect(after.observedReceipts).toBe(before.observedReceipts + 1)
        expect(after.invalidations).toContain(CaptureInvalidation.Persistence)
        yield* TestClock.adjust(7000)
        yield* Deferred.succeed(release, undefined)
        yield* TestClock.adjust(0)
        expect(operation.events.find(([name]) => name === 'bayn.capture.persistence.cleanup_finished')?.[1]).toBe(
          8_050_000_000n,
        )
        expect(saved.chunks).toHaveLength(1)
        expect((yield* recorder.status).persistedReceipts).toBe(0)
        expect(events(operation)).not.toContain('bayn.capture.persistence.io_completed')
        const sql = saved.spans.find((span) => span.name === 'bayn.capture.sql')
        if (sql === undefined) throw new Error('Missing delayed SQL span')
        expect(events(sql)).not.toContain('bayn.capture.sql.acknowledged')
        yield* recorder.finish
        expect(saved.chunks).toHaveLength(1)
      }),
      saved.tracer,
    )
  },
)

test.each(['defect', 'self-interrupt', 'cancel'] as const)(
  'SQL %s preserves the owner outcome without exporting the adapter cause',
  async (mode) => {
    const saved = fixture()
    const secret = 'private-sql-adapter-secret'
    const result = await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            append: () =>
              mode === 'defect'
                ? Effect.die(new Error(secret))
                : mode === 'self-interrupt'
                  ? Effect.interrupt
                  : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          },
          options,
        )
        recorder.record(captureEvent('STARTED'), 0)
        if (mode === 'cancel') {
          const finishing = yield* recorder.finish.pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(finishing)
        } else {
          yield* recorder.finish
        }
        expect((yield* recorder.status).persistedReceipts).toBe(0)
        return 'native owner unchanged'
      }),
      saved.tracer,
    )
    expect(result).toBe('native owner unchanged')
    const sql = saved.spans.find((span) => span.name === 'bayn.capture.sql')
    if (sql === undefined) throw new Error('Missing failed SQL span')
    expect(events(sql)).not.toContain('bayn.capture.sql.acknowledged')
    const emitted = JSON.stringify(
      saved.spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events.map(([name, time, attributes]) => [name, String(time), attributes]),
        outcome: span.status._tag === 'Ended' ? span.status.exit : null,
      })),
    )
    expect(emitted).not.toContain(secret)
    expect(emitted).not.toContain(options.captureId)
    expect(sql.status).toMatchObject({
      _tag: 'Ended',
      exit: mode === 'cancel' ? { _tag: 'Failure' } : { _tag: 'Success', value: undefined },
    })
  },
)

test.each(['object', 'sql'] as const)(
  'failed %s capture writes retain unknown outcomes without sensitive trace data',
  async (stage) => {
    const saved = fixture()
    const secret = 'private-endpoint/password/payload/capture-id'
    const failure = Effect.fail(new ResearchCaptureFailure({ message: secret, cause: new Error(secret) }))
    await run(
      Effect.gen(function* () {
        const recorder = yield* makeResearchCaptureRecorder(
          {
            append: (bytes) => (stage === 'sql' ? failure : saved.store.append(bytes)),
            seal: () => failure,
          },
          options,
          { putVerified: () => (stage === 'object' ? failure : Effect.void) },
        )
        recorder.record(captureEvent('STARTED'), 0)
        yield* recorder.finish
        expect((yield* recorder.status).persistedReceipts).toBe(0)
        expect((yield* recorder.status).invalidations).toContain(CaptureInvalidation.Persistence)
      }),
      saved.tracer,
    )
    const sql = saved.spans.filter((span) => span.name === 'bayn.capture.sql')
    expect(sql.length).toBe(stage === 'object' ? 0 : 2)
    for (const span of sql)
      expect(events(span)).toEqual(['bayn.capture.sql.started', 'bayn.capture.sql.failed_or_unknown'])
    const emitted = JSON.stringify(
      saved.spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events.map(([name, time, attributes]) => [name, String(time), attributes]),
        outcome: span.status._tag === 'Ended' ? span.status.exit : null,
      })),
    )
    expect(emitted).not.toContain(secret)
    expect(emitted).not.toContain(options.captureId)
    expect(emitted).not.toContain(options.sourceRevision)
    for (const span of saved.spans) {
      expect(
        [...span.attributes.keys()].every((key) =>
          [
            'bayn.capture.persistence.operation',
            'bayn.capture.metadata.sha256',
            'bayn.capture.metadata.bytes',
            'bayn.capture.chunk.ordinal',
            'bayn.capture.persistence.deadline_ms',
            'bayn.capture.sql.operation',
          ].includes(key),
        ),
      ).toBe(true)
    }
  },
)
