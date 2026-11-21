import { describe, expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Logger, Result, type Tracer } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { observedBrokerState, type ObservedBrokerSnapshot } from '../broker/alpaca/observed-snapshot'
import { canonicalHashV1Result } from '../hash'
import { valkeyFixture } from '../testing/valkey-fixture'
import { ValkeyCacheError } from '../valkey-cache'
import { makeBrokerObservationStore } from './broker-observations'

const accountId = 'materialization-test'
const revision = 'a'.repeat(40)
const at = '2026-11-17T15:00:00.000Z'
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))

const fixture = () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at))
    const valkey = valkeyFixture()
    let snapshotKey = ''
    let row = { generation: 1, snapshot_hash: '', state_hash: '', observedAt: at }
    let fence: 'admitted' | 'pending' | 'rejected' = 'admitted'
    let getBehavior: 'normal' | 'failed' | 'defect' | 'interrupted' | 'elapsed' = 'normal'
    let queries = 0
    let gets = 0
    const spans: Tracer.Span[] = []
    const sql = ((strings: TemplateStringsArray) =>
      Effect.sync(() => {
        queries++
        const query = strings.join('')
        if (query.includes('AS "foreignRevision"')) return [{ foreignRevision: false }]
        if (query.includes('AND available')) return fence === 'admitted' ? [row] : []
        return fence === 'pending'
          ? [{ ...row, newerMutation: true, newerBrokerEvent: false, newerNotification: false }]
          : []
      })) as unknown as PgClient.PgClient
    const cache = {
      ...valkey.cache,
      get: (key: string) =>
        Effect.gen(function* () {
          gets++
          spans.push(yield* Effect.currentSpan.pipe(Effect.orDie))
          if (getBehavior === 'failed')
            return yield* new ValkeyCacheError({ operation: 'get', message: 'fixture unavailable' })
          if (getBehavior === 'defect') return yield* Effect.die('fixture defect')
          if (getBehavior === 'interrupted') return yield* Effect.interrupt
          if (getBehavior === 'elapsed') yield* TestClock.adjust('60 seconds')
          return yield* valkey.cache.get(key)
        }),
    }
    const store = makeBrokerObservationStore(sql, accountId, revision, 60_000, cache)
    const write = (snapshot: ObservedBrokerSnapshot) =>
      Effect.gen(function* () {
        const snapshotHash = hash(snapshot)
        const state = { snapshotHash, state: observedBrokerState(snapshot) }
        const stateHash = hash(state)
        row = { generation: 1, snapshot_hash: snapshotHash, state_hash: stateHash, observedAt: snapshot.observedAt }
        snapshotKey = `bayn:broker:snapshot:${hash({ accountId, sourceRevision: revision, hash: snapshotHash })}`
        yield* cache.putAll([
          { key: snapshotKey, value: JSON.stringify(snapshot), ttlMs: 300_000 },
          {
            key: `bayn:broker:state:${hash({ accountId, sourceRevision: revision, hash: stateHash })}`,
            value: JSON.stringify(state),
            ttlMs: 300_000,
          },
        ])
      })
    const snapshot = observedBrokerSnapshotFixture(accountId, at)
    yield* write(snapshot)
    return {
      snapshot,
      store,
      write,
      replaceBytes: (value: string) => cache.put({ key: snapshotKey, value, ttlMs: 300_000 }),
      replaceClaimedHash: (claimedHash: string) => {
        const original = valkey.values.get(snapshotKey)
        if (original === undefined) throw new Error('Missing fixture snapshot')
        row = { ...row, snapshot_hash: claimedHash }
        const key = `bayn:broker:snapshot:${hash({ accountId, sourceRevision: revision, hash: claimedHash })}`
        return cache.put({ key, value: original.value, ttlMs: 300_000 })
      },
      remove: () => cache.remove(snapshotKey),
      setFence: (value: typeof fence) => {
        fence = value
      },
      setGetBehavior: (value: typeof getBehavior) => {
        getBehavior = value
      },
      counts: () => ({ queries, gets }),
      reused: () => spans.map((span) => span.attributes.get('bayn.broker.payload_decode_reused')),
    }
  })

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])), Effect.runPromise)

describe('Broker snapshot materialization reuse', () => {
  test('reuses only decoding while rereading fences and bytes, with detached complete evidence', async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        const first = yield* f.store.read
        expect(first).toEqual(f.snapshot)
        Object.assign(first.snapshot.account.value, { cashMicros: '0' })
        Object.assign(first.snapshot.history.orders.rows[0]?.value ?? {}, { symbol: 'CHANGED' })
        const second = yield* f.store.read
        expect(second).toEqual(f.snapshot)
        expect(second).not.toBe(first)
        expect(second.snapshot.history.orders.rows).not.toBe(first.snapshot.history.orders.rows)
        expect(hash(second)).toBe(hash(f.snapshot))
        expect(f.counts()).toEqual({ queries: 2, gets: 2 })
        expect(f.reused()).toEqual([false, true])
        Object.assign(second.snapshot.account.value, { cashMicros: '1' })
        expect(yield* f.store.read).toEqual(f.snapshot)
        expect(f.counts()).toEqual({ queries: 3, gets: 3 })
      }),
    )
  })

  test.each([
    'missing',
    'invalid-json',
    'extra-property',
    'changed-content',
    'wrong-hash',
    'failed',
    'defect',
    'interrupted',
  ] as const)('a warmed decode never supplies missing or invalid fresh evidence: %s', async (mode) => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.store.read
        if (mode === 'missing') yield* f.remove()
        if (mode === 'invalid-json') yield* f.replaceBytes('{')
        if (mode === 'extra-property') yield* f.replaceBytes(JSON.stringify({ ...f.snapshot, extra: true }))
        if (mode === 'wrong-hash') yield* f.replaceClaimedHash('b'.repeat(64))
        if (mode === 'changed-content') {
          const changed = structuredClone(f.snapshot)
          Object.assign(changed.snapshot.account.value, { cashMicros: '1' })
          yield* f.replaceBytes(JSON.stringify(changed))
        }
        if (mode === 'failed' || mode === 'defect' || mode === 'interrupted') f.setGetBehavior(mode)
        const exit = yield* f.store.read.pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          if (mode === 'interrupted') expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          else expect(Cause.hasInterrupts(exit.cause)).toBe(false)
          expect(Cause.hasDies(exit.cause)).toBe(mode === 'defect')
        }
        expect(f.counts()).toEqual({ queries: 2, gets: 2 })
      }),
    )
  })

  test('canonical-equivalent changed bytes require full verification again', async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.store.read
        yield* f.replaceBytes(` ${JSON.stringify(f.snapshot)}`)
        expect(yield* f.store.read).toEqual(f.snapshot)
        expect(yield* f.store.read).toEqual(f.snapshot)
        expect(f.reused()).toEqual([false, false, true])
      }),
    )
  })

  test.each(['pending', 'rejected'] as const)('fresh %s fences still reject a warmed snapshot', async (fence) => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.store.read
        f.setFence(fence)
        const error = yield* f.store.read.pipe(Effect.flip)
        expect(error.kind).toBe(
          fence === 'pending' ? BrokerReadErrorKind.ObservationPending : BrokerReadErrorKind.Timeout,
        )
        expect(f.counts()).toEqual({ queries: fence === 'pending' ? 3 : 4, gets: fence === 'pending' ? 2 : 1 })
      }),
    )
  })

  test('age is checked again after a warm materialization crosses the original deadline', async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.store.read
        f.setGetBehavior('elapsed')
        const error = yield* f.store.read.pipe(Effect.flip)
        expect(error.message).toContain('stale-observation')
        expect(f.reused()).toEqual([false, true])
        expect(f.counts()).toEqual({ queries: 2, gets: 2 })
      }),
    )
  })

  test.each(['account', 'chronology', 'future'] as const)(
    'pure reuse cannot admit an invalid current %s binding',
    async (reason) => {
      await run(
        Effect.gen(function* () {
          const f = yield* fixture()
          const snapshot =
            reason === 'account'
              ? observedBrokerSnapshotFixture('foreign-account', at)
              : reason === 'chronology'
                ? { ...f.snapshot, startedAt: '2026-11-17T15:00:00.001Z' }
                : f.snapshot
          yield* f.write(snapshot)
          yield* TestClock.setTime(Date.parse(at) + (reason === 'future' ? -1 : 2))
          const first = yield* f.store.read.pipe(Effect.flip)
          const second = yield* f.store.read.pipe(Effect.flip)
          expect(first.message).toContain(
            reason === 'account'
              ? 'account-mismatch'
              : reason === 'chronology'
                ? 'invalid-chronology'
                : 'future-observation',
          )
          expect(second.message).toBe(first.message)
          expect(f.reused()).toEqual([false, true])
          expect(f.counts()).toEqual({ queries: 2, gets: 2 })
        }),
      )
    },
  )

  test('only one full snapshot is retained and compact submission state is always verified', async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.store.read
        const changed = structuredClone(f.snapshot)
        Object.assign(changed.snapshot.account.value, { cashMicros: '1' })
        yield* f.write(changed)
        expect(yield* f.store.read).toEqual(changed)
        yield* f.write(f.snapshot)
        expect(yield* f.store.read).toEqual(f.snapshot)
        expect(yield* f.store.readState).toEqual(observedBrokerState(f.snapshot))
        expect(yield* f.store.readForSubmit('b'.repeat(64))).toEqual(observedBrokerState(f.snapshot))
        expect(f.reused()).toEqual([false, false, false, false, false])
        expect(f.counts()).toEqual({ queries: 5, gets: 5 })
      }),
    )
  })

  test('oversized valid payloads still validate and are never retained', async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* fixture()
        const large = structuredClone(f.snapshot)
        Object.assign(large.snapshot.account.evidence, { requestId: 'x'.repeat(8 * 1024 * 1024) })
        yield* f.write(large)
        expect(hash(yield* f.store.read)).toBe(hash(large))
        expect(hash(yield* f.store.read)).toBe(hash(large))
        expect(f.reused()).toEqual([false, false])
        expect(f.counts()).toEqual({ queries: 2, gets: 2 })
      }),
    )
  })
})
