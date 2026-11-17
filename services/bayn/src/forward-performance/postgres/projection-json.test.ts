import { expect, test } from 'bun:test'

import { retainedV38ExecutionFixture, retainedV38ExecutionGoldens } from '../../jev/retained-v38-execution.test-support'
import { verifyPerformanceDecisionJson, verifyPerformanceDecisions } from './projection'

const metadata = {
  cycle_id: 'a'.repeat(64),
  decision_hash: 'b'.repeat(64),
  created_at: new Date('2026-11-15T00:00:00.000Z'),
}

test('SQL null retains the original unsupported null document behavior', () => {
  expect(verifyPerformanceDecisionJson({ ...metadata, document_json: null })).toEqual(
    verifyPerformanceDecisions([{ ...metadata, document: null }]),
  )
})

test.each(retainedV38ExecutionGoldens.map((_, index) => index))(
  'JSON text preserves the original verified retained document and metadata: %i',
  (index) => {
    const { document, bytes } = retainedV38ExecutionFixture(index)
    const row = {
      cycle_id: document.bindings.cycleId,
      decision_hash: document.contentHash,
      created_at: new Date(document.createdAt),
      document: JSON.parse(bytes.toString('utf8')),
    }
    const { document: original, ...metadata } = row
    const expected = verifyPerformanceDecisions([row])
    expect(expected.verifiedRows).toHaveLength(1)
    expect(verifyPerformanceDecisionJson({ ...metadata, document_json: bytes.toString('utf8') })).toEqual(expected)
    expect(verifyPerformanceDecisionJson({ ...metadata, document_json: JSON.stringify(original, null, 2) })).toEqual(
      expected,
    )
  },
)

test('JSON text preserves numeric values and escaped strings while rejecting a number changed into a string', () => {
  const { document, bytes } = retainedV38ExecutionFixture(1)
  const original = JSON.parse(bytes.toString('utf8'))
  const row = {
    cycle_id: document.bindings.cycleId,
    decision_hash: document.contentHash,
    created_at: new Date(document.createdAt),
    document: original,
  }
  const { document: _, ...metadata } = row
  const text = JSON.stringify(original)
  const equivalent = text
    .replace('"maximumQuoteAgeMs":10000', '"maximumQuoteAgeMs":1e4')
    .replace('"accountId":"jev-native-test"', '"accountId":"jev\\u002dnative\\u002dtest"')
  expect(equivalent).not.toBe(text)
  const expected = verifyPerformanceDecisions([row])
  expect(expected.verifiedRows).toHaveLength(1)
  expect(verifyPerformanceDecisionJson({ ...metadata, document_json: equivalent })).toEqual(expected)
  const changed = {
    ...original,
    bindings: {
      ...original.bindings,
      executionMarketData: { ...original.bindings.executionMarketData, maximumQuoteAgeMs: '10000' },
    },
  }
  const rejected = verifyPerformanceDecisionJson({ ...metadata, document_json: JSON.stringify(changed) })
  expect(rejected).toEqual(verifyPerformanceDecisions([{ ...row, document: changed }]))
  expect(rejected).toEqual({ verifiedRows: [], unverifiedDecisionHashes: [row.decision_hash] })
})

test('JSON text keeps content corruption subject to the original complete verifier', () => {
  const { document, bytes } = retainedV38ExecutionFixture(0)
  const changed = { ...JSON.parse(bytes.toString('utf8')), contentHash: 'f'.repeat(64) }
  const row = {
    cycle_id: document.bindings.cycleId,
    decision_hash: document.contentHash,
    created_at: new Date(document.createdAt),
    document: changed,
  }
  const { document: _, ...metadata } = row
  expect(verifyPerformanceDecisionJson({ ...metadata, document_json: JSON.stringify(changed) })).toEqual(
    verifyPerformanceDecisions([row]),
  )
  expect(verifyPerformanceDecisionJson({ ...metadata, document_json: JSON.stringify(changed) })).toEqual({
    verifiedRows: [],
    unverifiedDecisionHashes: [row.decision_hash],
  })
})

test.each(['null', 'true', '1e3', '"9007199254740993"', '[]', '{"schemaVersion":"unsupported","n":1.25}'])(
  'valid unsupported JSON retains the original unverified decision hash: %s',
  (document_json) => {
    expect(verifyPerformanceDecisionJson({ ...metadata, document_json })).toEqual(
      verifyPerformanceDecisions([{ ...metadata, document: JSON.parse(document_json) }]),
    )
    expect(verifyPerformanceDecisionJson({ ...metadata, document_json })).toEqual({
      verifiedRows: [],
      unverifiedDecisionHashes: [metadata.decision_hash],
    })
  },
)

test.each(['', '{', '[1,]', '{"n":NaN}', 'null trailing'])(
  'malformed JSON records the original hash without throwing or producing evidence: %s',
  (document_json) => {
    expect(verifyPerformanceDecisionJson({ ...metadata, document_json })).toEqual({
      verifiedRows: [],
      unverifiedDecisionHashes: [metadata.decision_hash],
    })
  },
)
