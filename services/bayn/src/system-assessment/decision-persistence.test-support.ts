import { Effect, Result } from 'effect'

import { jevObservationForSnapshot, nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { decideJevEntry } from '../jev/decision'
import { JevPurpose } from '../jev/portfolio'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { continuousExecutionPolicy, continuousMarketHours, tradingWindow } from '../market-hours'
import { makeStrategyProtocolHashResult } from '../contracts'
import { jevBehaviorHash } from '../jev/protocol'
import { canonicalHashV1Result } from '../hash'
import { makeJevObservation } from '../jev/observation'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'

export const makePersistenceDocumentFixture = (accountId: string) =>
  Effect.gen(function* () {
    const native = nativeJevFixture(JevPurpose.Entry, undefined, accountId)
    const evidence = nativeJevDecisionEvidence(native)
    const target = Result.getOrThrow(decideJevEntry(evidence))
    const { candidateEvidencePolicy: _candidates, candidateSymbols: _symbols, ...query } = native.query
    const pricing = streamingFixtureFromRaw(native.snapshot, {
      ...query,
      observedAt: target.decidedAt,
      symbols: target.selectedSymbols,
      purpose: IntradaySnapshotPurpose.EntryPricing,
    }).snapshot
    return yield* matchedCommittedDecisionFixture(native, evidence, '100000000000', pricing, 3)
  })

export const persistenceDocumentFixture = makePersistenceDocumentFixture('jev-native-test')

export const cryptoPersistenceDocumentFixture = Effect.gen(function* () {
  const { cut, query, snapshot } = cryptoMarketFixture('BTC/USD', {
    quoteAskSize: 0.8,
    observedPriceChoices: true,
  })
  const { protocol, portfolio, authorityGenerationHash, observedAt } = Result.getOrThrow(
    jevObservationForSnapshot(snapshot),
  ).payload
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
  const lease = Result.getOrThrow(
    tradingWindow(continuousMarketHours, observedAt, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
  )
  if (lease === null) return yield* Effect.die('Expected an active continuous-market lease')
  const draft = Result.getOrThrow(
    makeIntradayCycleDraft(
      {
        cycleBindingId: 'a'.repeat(64),
        strategyName: 'jev',
        strategyProtocolHash: Result.getOrThrow(
          makeStrategyProtocolHashResult({
            name: 'jev',
            behaviorHash: jevBehaviorHash,
            parameterHash: Result.getOrThrow(canonicalHashV1Result(protocol)),
            parameterSchemaVersion: protocol.schemaVersion,
          }),
        ),
        accountId: portfolio.brokerState.account.accountId,
        executionPolicy,
      },
      continuousMarketHours,
      lease,
    ),
  )
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: draft.identity.cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
    }),
  )
  const native = { protocol, portfolio, draft, observation, snapshot }
  const evidence = nativeJevDecisionEvidence(native)
  const { candidateSymbols: _candidates, candidateEvidencePolicy: _policy, ...pricingQuery } = query
  const pricing = Result.getOrThrow(
    constructStreamingSnapshot(cut, {
      ...pricingQuery,
      observedAt: evidence.decidedAt,
      symbols: ['BTC/USD'],
      purpose: IntradaySnapshotPurpose.EntryPricing,
    }),
  )
  return yield* matchedCommittedDecisionFixture(native, evidence, '100000000000', pricing, 3)
})
