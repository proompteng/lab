import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Option, Result, pipe } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../config'
import {
  selectCyclePublicationManifests,
  selectPublicationManifest,
  verifyFinalizedCalendar,
  verifyFinalizedManifest,
  verifyFinalizedSnapshot,
  verifyBoundFinalizedPublication,
  verifyCyclePublications,
  type MarketDataVerificationError,
} from '../market-data-verification'
import { currentUtcInstant } from '../time'
import { marketDataOperationError } from './errors'
import {
  MarketData,
  type FinalizedPublicationDiscovery,
  type FinalizedPublicationInspection,
  type FinalizedPublicationRequest,
  type MarketDataContract,
  type MarketDataService,
  type SnapshotPublicationRequest,
  type SnapshotRequest,
} from './model'
import { cyclePublicationCandidateLimit, makeMarketDataQueries } from './queries'
import { decodeSnapshotRows, type SignalManifestRow } from './rows'
import { Pipeable } from '../pipeable'

const makeMarketDataDataFirst = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Effect.Effect<MarketDataService, never, ClickhouseClient.ClickhouseClient> =>
  pipe(
    ClickhouseClient.ClickhouseClient,
    Effect.map((sql): MarketDataService => {
      const {
        loadBars,
        loadCyclePublicationManifests,
        loadCyclePublicationSessions,
        loadManifests,
        loadPublicationManifests,
        loadPublicationSessions,
        loadSessions,
        loadSnapshotPublicationBars,
        loadSnapshotPublicationManifest,
      } = makeMarketDataQueries(sql, config, contract)

      const request = (observedAt: string): SnapshotRequest => {
        const common = {
          snapshotId: config.clickhouse.snapshotId,
          publicationAsOf: config.clickhouse.publicationAsOf,
          calendarVersion: config.clickhouse.calendarVersion,
          universe: contract.universe,
          bounds: config.clickhouse.bounds,
          observedAt,
        } as const
        return {
          ...common,
          universeId: contract.universeId,
          universeSymbolHash: contract.universeSymbolHash,
          historyStart: contract.historyStart,
          evaluationStart: contract.evaluationStart,
        }
      }
      const snapshotPublicationRequest = (input: SnapshotPublicationRequest, observedAt: string): SnapshotRequest => ({
        snapshotId: input.snapshotId,
        publicationAsOf: input.signalSessionDate,
        calendarVersion: input.signalCalendarVersion,
        universe: contract.universe,
        bounds: {
          schemaVersion: 'bayn.evaluation-bounds.v1',
          dataStart: contract.historyStart,
          dataEnd: input.signalSessionDate,
          lookbackStart: contract.historyStart,
          evaluationStart: contract.evaluationStart,
          evaluationEnd: input.signalSessionDate,
        },
        observedAt,
        universeId: contract.universeId,
        universeSymbolHash: contract.universeSymbolHash,
        historyStart: contract.historyStart,
        evaluationStart: contract.evaluationStart,
      })
      const verify = <A>(
        result: Result.Result<A, MarketDataVerificationError>,
      ): Effect.Effect<A, MarketDataVerificationError> => Effect.fromResult(result)

      const observedAt = currentUtcInstant

      const decodeManifestRows = (
        rows: readonly unknown[],
      ): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> =>
        pipe(
          decodeSnapshotRows([], [], rows),
          Result.map((snapshot) => snapshot.manifests),
        )

      const inspectPublicationRows = (
        input: FinalizedPublicationRequest,
        manifestRows: readonly unknown[],
        expectedSnapshotId?: string,
      ): Effect.Effect<FinalizedPublicationInspection, MarketDataVerificationError | SqlError> =>
        pipe(
          decodeManifestRows(manifestRows),
          Result.flatMap((manifests) => selectPublicationManifest(manifests, expectedSnapshotId)),
          verify,
          Effect.flatMap((manifest) =>
            pipe(
              Option.fromNullishOr(manifest),
              Option.match({
                onNone: () =>
                  pipe(
                    observedAt,
                    Effect.map(
                      (instant): FinalizedPublicationInspection => ({ outcome: 'MISSING', observedAt: instant }),
                    ),
                  ),
                onSome: (selected) =>
                  pipe(
                    loadPublicationSessions(selected.snapshot_id),
                    Effect.flatMap((sessionRows) =>
                      pipe(
                        observedAt,
                        Effect.flatMap((inspectedAt) =>
                          pipe(
                            decodeSnapshotRows([], sessionRows, manifestRows),
                            Result.flatMap((rows) =>
                              verifyBoundFinalizedPublication(rows, input, contract, inspectedAt, expectedSnapshotId),
                            ),
                            verify,
                            Effect.map(
                              (inspection): FinalizedPublicationInspection => ({
                                outcome: 'FINALIZED',
                                observedAt: inspectedAt,
                                inspection,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              }),
            ),
          ),
        )

      const inspectCyclePublicationRows = (
        manifestRows: readonly unknown[],
      ): Effect.Effect<FinalizedPublicationDiscovery, MarketDataVerificationError | SqlError> =>
        pipe(
          decodeManifestRows(manifestRows),
          Result.flatMap((manifests) => selectCyclePublicationManifests(manifests, cyclePublicationCandidateLimit)),
          verify,
          Effect.flatMap((manifests) =>
            pipe(
              Option.fromNullishOr(manifests[0]),
              Option.match({
                onNone: () =>
                  pipe(
                    observedAt,
                    Effect.map(
                      (instant): FinalizedPublicationDiscovery => ({ outcome: 'MISSING', observedAt: instant }),
                    ),
                  ),
                onSome: () => {
                  const snapshotIds = manifests.map((manifest) => manifest.snapshot_id)
                  return pipe(
                    loadCyclePublicationSessions(snapshotIds),
                    Effect.flatMap((sessionRows) =>
                      pipe(
                        observedAt,
                        Effect.flatMap((inspectedAt) =>
                          pipe(
                            decodeSnapshotRows([], sessionRows, []),
                            Result.flatMap((rows) =>
                              verifyCyclePublications(manifests, rows.sessions, contract, inspectedAt),
                            ),
                            verify,
                            Effect.map(
                              (publications): FinalizedPublicationDiscovery => ({
                                outcome: 'FINALIZED',
                                observedAt: inspectedAt,
                                publications,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
                },
              }),
            ),
          ),
        )

      return {
        check: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              loadManifests,
              Effect.flatMap((manifests) =>
                pipe(
                  decodeSnapshotRows([], [], manifests),
                  Result.flatMap((rows) => verifyFinalizedManifest(rows.manifests, request(instant))),
                  verify,
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('check', 'failed to check finalized Signal snapshot', cause),
          ),
        ),
        inspect: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              Effect.all({ manifests: loadManifests, sessions: loadSessions }, { concurrency: 2 }),
              Effect.flatMap(({ manifests, sessions }) =>
                pipe(
                  decodeSnapshotRows([], sessions, manifests),
                  Result.flatMap((rows) => verifyFinalizedCalendar(rows, request(instant))),
                  verify,
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('inspect', 'failed to inspect finalized Signal calendar', cause),
          ),
        ),
        inspectCyclePublications: loadCyclePublicationManifests.pipe(
          Effect.flatMap(inspectCyclePublicationRows),
          Effect.mapError((cause) =>
            marketDataOperationError(
              'inspect-publication',
              'failed to inspect bounded finalized Signal publication candidates',
              cause,
            ),
          ),
        ),
        inspectPublication: (input) =>
          loadPublicationManifests(input).pipe(
            Effect.flatMap((manifestRows) => inspectPublicationRows(input, manifestRows)),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'inspect-publication',
                `failed to inspect finalized Signal publication for ${input.signalSessionDate}`,
                cause,
              ),
            ),
          ),
        inspectSnapshotPublication: (input) =>
          loadSnapshotPublicationManifest(input).pipe(
            Effect.flatMap((manifestRows) => inspectPublicationRows(input, manifestRows, input.snapshotId)),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'inspect-publication',
                `failed to inspect bound finalized Signal publication ${input.snapshotId}`,
                cause,
              ),
            ),
          ),
        loadSnapshotPublication: (input) =>
          pipe(
            Effect.all(
              {
                manifests: loadSnapshotPublicationManifest(input),
                sessions: loadPublicationSessions(input.snapshotId),
                bars: loadSnapshotPublicationBars(input.snapshotId),
              },
              { concurrency: 3 },
            ),
            Effect.flatMap(({ bars, manifests, sessions }) =>
              pipe(
                observedAt,
                Effect.flatMap((instant) =>
                  pipe(
                    decodeSnapshotRows(bars, sessions, manifests),
                    Result.flatMap((rows) => verifyFinalizedSnapshot(rows, snapshotPublicationRequest(input, instant))),
                    verify,
                  ),
                ),
              ),
            ),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'load',
                `failed to load bound finalized Signal snapshot ${input.snapshotId}`,
                cause,
              ),
            ),
          ),
        load: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              Effect.all({ manifests: loadManifests, sessions: loadSessions, bars: loadBars }, { concurrency: 3 }),
              Effect.flatMap(({ bars, manifests, sessions }) =>
                pipe(
                  decodeSnapshotRows(bars, sessions, manifests),
                  Result.flatMap((rows) => verifyFinalizedSnapshot(rows, request(instant))),
                  verify,
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('load', 'failed to load finalized Signal snapshot', cause),
          ),
        ),
      }
    }),
  )

export const makeMarketData = Pipeable.dual(2, makeMarketDataDataFirst)

const MarketDataLiveDataFirst = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Layer.Layer<MarketData, never, ClickhouseClient.ClickhouseClient> =>
  Layer.effect(MarketData, makeMarketData(config, contract))

export const MarketDataLive = Pipeable.dual(2, MarketDataLiveDataFirst)
