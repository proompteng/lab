import { describe, expect, test } from 'bun:test'

import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect } from 'effect'

import { makeDailySnapshotQueries } from './queries'

const makeSqlRecorder = (queryIds: string[]): ClickhouseClient.ClickhouseClient => {
  const statement = (): Effect.Effect<readonly unknown[]> => Effect.succeed([])
  return Object.assign(statement, {
    param: (_type: string, value: unknown) => value,
    withQueryId:
      (queryId: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => queryIds.push(queryId)).pipe(Effect.andThen(effect)),
  }) as unknown as ClickhouseClient.ClickhouseClient
}

describe('market-data query execution identity', () => {
  test('keeps one logical operation while assigning every concurrent replica attempt a unique query id', async () => {
    const queryIds: string[] = []
    const left = makeDailySnapshotQueries(makeSqlRecorder(queryIds))
    const right = makeDailySnapshotQueries(makeSqlRecorder(queryIds))

    await Effect.runPromise(
      Effect.all(
        [
          left.loadSnapshotPublicationManifest('snapshot-fixture'),
          left.loadSnapshotPublicationManifest('snapshot-fixture'),
          right.loadSnapshotPublicationManifest('snapshot-fixture'),
          right.loadSnapshotPublicationManifest('snapshot-fixture'),
        ],
        { concurrency: 'unbounded' },
      ),
    )

    expect(queryIds).toHaveLength(4)
    expect(new Set(queryIds).size).toBe(4)
    expect(queryIds.every((queryId) => /^bayn-bound-manifest-[0-9a-f-]{36}$/.test(queryId))).toBe(true)
  })
})
