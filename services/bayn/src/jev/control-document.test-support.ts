import { Effect, Result } from 'effect'

import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { matchedCommittedTargetFixture } from '../intraday-replay/matched-entry.test-support'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { exchangeSessions } from '../market-hours'
import { decideRepeatedMomentumEntry } from '../strategy/repeated-momentum/decision'
import { makeRepeatedMomentumPolicy, repeatedMomentumStrategyIdentity } from '../strategy/repeated-momentum/policy'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { JevBatchPlanVersion } from './batch'
import { decideEntryAblation } from './entry-ablation'
import { makeEntryAblationPolicy, entryAblationStrategyIdentity } from './entry-ablation-policy'
import { makeJevObservation } from './observation'
import { nativeJevBatchResult, nativeJevFixture } from './native.test-support'
import { makeJevTradingSignalBatch } from './trading-signals'

export const controlDocumentFixture = (mode: 'ablation' | 'momentum') =>
  Effect.gen(function* () {
    const original = nativeJevFixture()
    const momentumPolicy = makeRepeatedMomentumPolicy(original.protocol)
    const identity =
      mode === 'ablation'
        ? yield* Effect.fromResult(entryAblationStrategyIdentity(makeEntryAblationPolicy(original.protocol)))
        : yield* Effect.fromResult(repeatedMomentumStrategyIdentity(momentumPolicy))
    const session = exchangeSessions(original.snapshot.manifest.calendar)[0]
    if (session === undefined) return yield* Effect.die('Expected a native equity session')
    const executionPolicy = yield* Effect.fromResult(
      makeCycleExecutionPolicyFromModel(original.protocol.executionModel),
    )
    const draft = yield* Effect.fromResult(
      makeIntradayCycleDraft(
        {
          cycleBindingId: 'a'.repeat(64),
          strategyName: 'jev',
          strategyProtocolHash: identity.protocolHash,
          accountId: original.portfolio.brokerState.account.accountId,
          executionPolicy,
        },
        original.snapshot.manifest.calendar,
        session,
      ),
    )
    const observation = yield* Effect.fromResult(
      makeJevObservation({ ...original.input, cycleId: draft.identity.cycleId }),
    )
    const native = { ...original, draft, observation }
    const observedAt = observation.payload.observedAt
    const decidedAt = new Date(Date.parse(observedAt) + 100).toISOString()
    const decision =
      mode === 'ablation'
        ? yield* Effect.fromResult(
            Result.gen(function* () {
              const batchPlan = yield* makeJevTradingSignalBatch({
                observation: observation.payload,
                expiresAt: new Date(Date.parse(observedAt) + native.protocol.inferenceValidityMs).toISOString(),
                planVersion: JevBatchPlanVersion.Ablation,
              })
              return yield* decideEntryAblation({
                observation: observation.payload,
                batchPlan,
                batchResult: nativeJevBatchResult(batchPlan, decidedAt),
                decidedAt,
              })
            }),
          )
        : yield* Effect.fromResult(
            decideRepeatedMomentumEntry(
              {
                schemaVersion: 'bayn.repeated-momentum-evidence.v1',
                observation: observation.payload,
                decidedAt,
              },
              momentumPolicy,
            ),
          )
    const { candidateEvidencePolicy: _candidates, candidateSymbols: _symbols, ...query } = native.query
    const pricing = streamingFixtureFromRaw(native.snapshot, {
      ...query,
      observedAt: decidedAt,
      symbols: decision.selectedSymbols,
      purpose: IntradaySnapshotPurpose.EntryPricing,
    }).snapshot
    return yield* matchedCommittedTargetFixture(native, decision, '100000000000', pricing, 3)
  })
