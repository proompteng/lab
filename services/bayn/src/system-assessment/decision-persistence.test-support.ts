import { Effect, Result } from 'effect'

import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { decideJevEntry } from '../jev/decision'
import { JevPurpose } from '../jev/portfolio'

export const makePersistenceDocumentFixture = (accountId: string) =>
  Effect.gen(function* () {
    const native = nativeJevFixture(JevPurpose.Entry, undefined, accountId)
    const evidence = nativeJevDecisionEvidence(native)
    const target = Result.getOrThrow(decideJevEntry(evidence))
    const {
      candidateEvidencePolicy: _candidates,
      benchmarkEvidencePolicy: _benchmarks,
      candidateSymbols: _symbols,
      benchmarkSymbols: _benchmarkSymbols,
      ...query
    } = native.query
    const pricing = streamingFixtureFromRaw(native.snapshot, {
      ...query,
      observedAt: target.decidedAt,
      symbols: target.selectedSymbols,
      purpose: IntradaySnapshotPurpose.EntryPricing,
    }).snapshot
    return yield* matchedCommittedDecisionFixture(native, evidence, '100000000000', pricing, 3)
  })

export const persistenceDocumentFixture = makePersistenceDocumentFixture('jev-native-test')
