import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from './hash'
import { controlDocumentFixture } from './jev/control-document.test-support'
import { reproduceJevCandidateObservation } from './jev/observation'
import { decodeIntradayQuoteRows } from './market-data/intraday/rows'
import { compareRecords, normalizeQuote } from './market-data/intraday/verification'
import { strictParseOptions } from './schemas'
import { CycleDecisionDocumentSchema } from './shadow-decision-contract'
import { isProtectedEntryTarget } from './strategy/runtime-decision'
import {
  cryptoPersistenceDocumentFixture,
  persistenceDocumentFixture,
} from './system-assessment/decision-persistence.test-support'

const decode = Schema.decodeUnknownResult(CycleDecisionDocumentSchema, strictParseOptions)

test.each([
  { name: 'equity candidate', fixture: persistenceDocumentFixture },
  { name: 'crypto candidate', fixture: cryptoPersistenceDocumentFixture },
  { name: 'ablation', fixture: controlDocumentFixture('ablation') },
  { name: 'momentum', fixture: controlDocumentFixture('momentum') },
])(
  'projects $name original quotes only after complete source verification',
  async ({ fixture }) => {
    const original = await Effect.runPromise(fixture)
    const target = original.strategyDecision
    if (!isProtectedEntryTarget(target)) throw new Error('Expected an entry target')
    expect(target.selectedSymbols.length).toBeGreaterThan(0)
    const observation = target.evidence.observation
    const reconstructed = Result.getOrThrow(reproduceJevCandidateObservation(observation))
    const quotes = Result.getOrThrow(
      decodeIntradayQuoteRows(observation.rows.quotes).pipe(
        Result.flatMap((rows) => Result.all(rows.map(normalizeQuote))),
        Result.map((values) => values.toSorted(compareRecords)),
      ),
    )
    for (const symbol of target.selectedSymbols)
      expect(quotes.findLast((quote) => quote.symbol === symbol)).toEqual(reconstructed.snapshot.latestQuotes[symbol])

    const bytes = Result.getOrThrow(canonicalJsonV1Result(original))
    expect(Result.getOrThrow(canonicalJsonV1Result(Result.getOrThrow(decode(original))))).toBe(bytes)

    for (const mutation of [
      { ask_price: '999999.123456' },
      { event_at: '2020-01-01T00:00:00.000000000Z' },
      { source_offset: '9223372036854775807' },
      { symbol: 'UNBOUND' },
    ]) {
      const changed = structuredClone(original)
      const changedTarget = changed.strategyDecision
      if (!isProtectedEntryTarget(changedTarget)) throw new Error('Expected an entry target')
      const row = changedTarget.evidence.observation.rows.quotes.find(
        (quote) =>
          typeof quote === 'object' &&
          quote !== null &&
          'symbol' in quote &&
          quote.symbol === target.selectedSymbols[0],
      )
      if (typeof row !== 'object' || row === null) throw new Error('Expected the selected source quote')
      Object.assign(row, mutation)
      const { contentHash: _hash, ...material } = changed
      Object.assign(changed, { contentHash: Result.getOrThrow(canonicalHashV1Result(material)) })
      expect(Result.isFailure(decode(changed))).toBe(true)
      expect(Result.getOrThrow(canonicalJsonV1Result(Result.getOrThrow(decode(original))))).toBe(bytes)
    }
  },
  15_000,
)
