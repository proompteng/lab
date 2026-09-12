import { Result } from 'effect'
import { canonicalHashV1Result } from '../../hash'
import { decodeExecutionDecisionDocument, reconstructBoundIntradaySnapshot } from '../../shadow-decision-contract'
import { IntradaySnapshotFailure } from '../intraday/model'

/** Durable decoding replays the saved reducer cut and strategy, planner, and risk calculations. */
export const reproduceRecordedStreamingDecision = (input: unknown) =>
  Result.gen(function* () {
    const document = yield* decodeExecutionDecisionDocument(input)
    const decisions = document.bindings.decisionMarketData ?? document.bindings.executionMarketData
    const snapshots: {
      snapshotId: string
      contentHash: string
      epoch: string
      sequence: number
      featureIds: string[]
    }[] = []
    for (const [binding, rows] of [
      [decisions, document.decisionMarketDataRows],
      [document.bindings.executionMarketData, document.executionMarketDataRows ?? document.decisionMarketDataRows],
    ] as const) {
      if (binding?.schemaVersion !== 'bayn.execution-market-data-binding.v3') continue
      const snapshot = rows === undefined ? undefined : reconstructBoundIntradaySnapshot(binding, rows)
      if (snapshot === undefined)
        return yield* Result.fail(
          new IntradaySnapshotFailure({ reason: 'hash', message: 'Recorded streaming input cut does not reproduce' }),
        )
      if (!snapshots.some((value) => value.snapshotId === binding.snapshotId))
        snapshots.push({
          snapshotId: binding.snapshotId,
          contentHash: binding.contentHash,
          epoch: binding.streaming.bootstrap.epoch,
          sequence: binding.streaming.sequence,
          featureIds: binding.streaming.features.map((feature) => feature.value.featureId),
        })
    }
    if (snapshots.length === 0)
      return yield* Result.fail(
        new IntradaySnapshotFailure({ reason: 'request', message: 'Decision contains no streaming evidence' }),
      )
    const material = {
      schemaVersion: 'bayn.recorded-streaming-reproduction.v1' as const,
      evidenceMode: 'recorded-decision' as const,
      decisionContentHash: document.contentHash,
      strategyDecisionHash: document.bindings.strategyDecisionHash,
      createdAt: document.createdAt,
      snapshots,
      result: 'REPRODUCED' as const,
    }
    return { ...material, receiptHash: yield* canonicalHashV1Result(material) }
  })
