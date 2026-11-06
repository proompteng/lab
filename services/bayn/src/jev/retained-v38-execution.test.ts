import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import { strictParseOptions } from '../schemas'
import {
  CycleDecisionDocumentSchema,
  decodeExecutionDecisionDocument,
  decodeRetainedJevV38ExecutionDecisionDocument,
  makeExecutionDecisionDocument,
} from '../shadow-decision-contract'
import { RuntimeStrategyDecisionSchema } from '../strategy/runtime-decision'
import {
  persistenceDocumentFixture,
  cryptoPersistenceDocumentFixture,
} from '../system-assessment/decision-persistence.test-support'
import { protectiveStopDocumentFixture, makeProtectiveStopDocumentFixture } from './exit-document.test-support'
import { controlDocumentFixture } from './control-document.test-support'
import { RetainedJevV38ExitTargetSchema } from './retained-v38-targets'
import {
  retainedV38ExecutionFixture,
  retainedV38ExecutionGoldens,
  retainedV38FixtureBytes,
} from './retained-v38-execution.test-support'

test.each(retainedV38ExecutionGoldens.map((golden, index) => ({ ...golden, index })))(
  'preserves original v38 $name execution bytes and rejects current admission',
  ({ index, bytes: length, contentHash, canonicalHash }) => {
    const { bytes, document } = retainedV38ExecutionFixture(index)
    expect(bytes.byteLength).toBe(length)
    expect(sha256(bytes)).toBe(canonicalHash)
    expect(document.contentHash).toBe(contentHash)
    expect(Result.getOrThrow(canonicalJsonV1Result(document))).toBe(bytes.toString('utf8'))
    expect(Result.isFailure(decodeExecutionDecisionDocument(document))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(CycleDecisionDocumentSchema, strictParseOptions)(document)),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(RuntimeStrategyDecisionSchema, strictParseOptions)(document.strategyDecision),
      ),
    ).toBe(true)
    const { contentHash: _hash, ...material } = document
    expect(Result.isFailure(makeExecutionDecisionDocument(material))).toBe(true)
  },
)

test('retains the original wide-spread protective-stop target and its exact liquidation terms', () => {
  const bytes = retainedV38FixtureBytes('exit-protective-stop-target.json.gz')
  const target = Schema.decodeUnknownSync(
    RetainedJevV38ExitTargetSchema,
    strictParseOptions,
  )(JSON.parse(bytes.toString('utf8')))
  expect(bytes.byteLength).toBe(12_568)
  expect(sha256(bytes)).toBe('765492ba111076a59162a58e34a77e7d69246d5e44e81ca49d3814b3b769ef01')
  expect(Result.getOrThrow(canonicalJsonV1Result(target))).toBe(bytes.toString('utf8'))
  expect(target.evidence.protocol.maximumEntryQuoteDriftBps).toBe(10)
  expect(target.evidence.protocol.maximumEntryLimitSlippageBps).toBe(10)
})

test.each(retainedV38ExecutionGoldens.map((_, index) => index))(
  'retained v38 execution rejects mixed versions and tampering after outer rehash: %i',
  (index) => {
    const { document } = retainedV38ExecutionFixture(index)
    const withHash = (material: unknown) => ({
      ...(material as object),
      contentHash: Result.getOrThrow(canonicalHashV1Result(material)),
    })
    const { contentHash: _hash, ...material } = document
    const target = document.strategyDecision
    if (target === undefined || target.schemaVersion === 'bayn.execution-flat-target.v1')
      throw new Error('Expected native evidence')
    const changes = [
      { ...material, bindings: { ...document.bindings, strategyProtocolHash: 'f'.repeat(64) } },
      { ...material, bindings: { ...document.bindings, authorityGenerationHash: 'f'.repeat(64) } },
      {
        ...material,
        targetPlan: {
          ...document.targetPlan,
          intentTargets: document.targetPlan.intentTargets.map((intent) => ({
            ...intent,
            quantityAtoms: (BigInt(intent.quantityAtoms) + 1n).toString(),
          })),
        },
      },
      { ...material, deltaRisk: [] },
      { ...material, createdAt: document.expiresAt },
      ...['bayn.jev.protocol.v39', 'bayn.jev.protocol.v37', 'bayn.jev.protocol.unknown'].map((schemaVersion) => ({
        ...material,
        strategyDecision: {
          ...target,
          evidence:
            target.schemaVersion !== 'bayn.jev-exit-target.v5'
              ? {
                  ...target.evidence,
                  observation: {
                    ...target.evidence.observation,
                    protocol: { ...target.evidence.observation.protocol, schemaVersion },
                  },
                }
              : { ...target.evidence, protocol: { ...target.evidence.protocol, schemaVersion } },
        },
      })),
    ]
    for (const changed of changes)
      expect(Result.isFailure(decodeRetainedJevV38ExecutionDecisionDocument(withHash(changed)))).toBe(true)
    expect(
      Result.isFailure(decodeRetainedJevV38ExecutionDecisionDocument({ ...document, contentHash: 'f'.repeat(64) })),
    ).toBe(true)
  },
)

test.each([
  { name: 'candidate entry', fixture: persistenceDocumentFixture },
  { name: 'candidate crypto entry', fixture: cryptoPersistenceDocumentFixture },
  { name: 'candidate exit', fixture: protectiveStopDocumentFixture },
  { name: 'ablation entry', fixture: controlDocumentFixture('ablation') },
  { name: 'momentum entry', fixture: controlDocumentFixture('momentum') },
  { name: 'ablation exit', fixture: makeProtectiveStopDocumentFixture('ablation') },
  { name: 'momentum exit', fixture: makeProtectiveStopDocumentFixture('momentum') },
])(
  'fresh v39 $name remains current-only with unchanged raw exit allowances',
  async ({ fixture }) => {
    const document = await Effect.runPromise(fixture)
    expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
    expect(Result.isFailure(decodeRetainedJevV38ExecutionDecisionDocument(document))).toBe(true)
    const target = document.strategyDecision
    if (target?.schemaVersion === 'bayn.jev-exit-target.v5') {
      expect(target.evidence.protocol.schemaVersion).toBe('bayn.jev.protocol.v39')
      expect(target.evidence.protocol.maximumEntryQuoteDriftBps).toBe(10)
      expect(target.evidence.protocol.maximumEntryLimitSlippageBps).toBe(10)
    }
  },
  15_000,
)

test('retained native and control entry identities cannot be relabeled as one another', () => {
  const documents = [0, 2, 3].map((index) => retainedV38ExecutionFixture(index).document)
  for (const document of documents) {
    const { contentHash: _contentHash, ...original } = document
    for (const other of documents) {
      if (document.bindings.strategyProtocolHash === other.bindings.strategyProtocolHash) continue
      const material = {
        ...original,
        bindings: { ...original.bindings, strategyProtocolHash: other.bindings.strategyProtocolHash },
      }
      expect(
        Result.isFailure(
          decodeRetainedJevV38ExecutionDecisionDocument({
            ...material,
            contentHash: Result.getOrThrow(canonicalHashV1Result(material)),
          }),
        ),
      ).toBe(true)
    }
  }
}, 15_000)
