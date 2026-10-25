import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { sha256 } from '../hash'
import {
  decodeResearchRun,
  decodeRetainedResearchRun,
  hashResearch,
  maximumResearchStreamBytes,
  parseResearchOutput,
  ResearchOutcome,
  researchRequest,
  researchServingIdentity,
  sealResearchReceipt,
} from './contract'
import { researchExpensePlan, verifyResearchReceipt } from './store'
import {
  fullTokenBudgetStreamFixture,
  editorFixture,
  retainedEditorFixture,
  retainedReceiptFixture,
  streamFixture,
} from './test-support'

const run = editorFixture()
const id = Result.getOrThrow(hashResearch(run))
const receipt = (outcome = ResearchOutcome.Complete, stream = streamFixture(), completionTokens = 20) =>
  Result.getOrThrow(
    sealResearchReceipt(run, {
      runId: id,
      workerSourceRevision: null,
      requestHash: Result.getOrThrow(hashResearch(researchRequest(run))),
      startedAtMs: 0,
      completedAtMs: 1001,
      firstTokenAtMs: 1,
      outcome,
      httpStatus: 200,
      servingIdentity: researchServingIdentity(run.policy),
      serverRequestId: 'chatcmpl-synthetic',
      responseBase64: Buffer.from(stream).toString('base64'),
      responseHash: sha256(stream),
      responseText: '{"entry":"Assess"}',
      instructions: outcome === ResearchOutcome.Complete ? { entry: 'Assess' } : null,
      usage: { prompt_tokens: 10, completion_tokens: completionTokens, total_tokens: 10 + completionTokens },
    }),
  )
describe('frozen research contract and existing expense ledger', () => {
  test('recovers priced retained editor receipts without admitting new inference for that policy', () => {
    const old = retainedEditorFixture()
    const before = JSON.stringify(old)
    const receipt = retainedReceiptFixture(old)
    expect(Result.isFailure(decodeResearchRun(old))).toBe(true)
    expect(Result.getOrThrow(decodeRetainedResearchRun(old))).toEqual(old)
    expect(Result.getOrThrow(verifyResearchReceipt(old, receipt))).toEqual(receipt)
    expect(Result.getOrThrow(researchExpensePlan(old, receipt)).transfers[0]?.amount).toBe(1001000002n)
    expect(Result.isFailure(verifyResearchReceipt(editorFixture(), receipt))).toBe(true)
    expect(JSON.stringify(old)).toBe(before)
    expect(
      Result.isFailure(decodeRetainedResearchRun({ ...old, policy: { ...old.policy, checkpoint: '0'.repeat(40) } })),
    ).toBe(true)
  })
  test('constrains prompt edits to the native instruction JSON schema', () => {
    const current = editorFixture()
    expect(researchRequest(current)).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: {
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['entry'],
            properties: { entry: { type: 'string', maxLength: 2000 } },
          },
        },
      },
    })
    expect(
      Result.isFailure(parseResearchOutput(current, '<harness>{"currentInstructions":{"entry":"Assess"}}</harness>')),
    ).toBe(true)
    expect(Result.isFailure(parseResearchOutput(current, '{"currentInstructions":{"entry":"Assess"}}'))).toBe(true)
    expect(Result.isSuccess(parseResearchOutput(current, '{"entry":"Assess"}'))).toBe(true)
  })
  test.each([
    '{"entry":""}',
    '{"entry":"   "}',
    JSON.stringify({ entry: 'a'.repeat(2001) }),
    '{"entry":"Assess","notes":"extra output"}',
    '<harness>{"entry":"Assess"}</harness>',
    '{"entry":"Assess"} trailing text',
  ])('rejects non-native structured editor documents %#', (output) => {
    expect(Result.isFailure(parseResearchOutput(editorFixture(), output))).toBe(true)
  })
  test.each([
    'bayn.research-run.v1',
    'bayn.harness2-inference.v1',
    'bayn.jev-harness2-editor.v1',
    'bayn.jev-harness2-editor.v2',
    'bayn.jev-harness2-editor.v3',
  ])('rejects retired new registrations %s', (schemaVersion) =>
    expect(Result.isFailure(decodeResearchRun({ ...run, schemaVersion }))).toBe(true),
  )
  test('binds the current general editor and rejects reflection and factor policy', () => {
    expect(Result.isFailure(decodeResearchRun({ ...run, purpose: 'reflection' }))).toBe(true)
    expect(Result.isFailure(decodeResearchRun({ ...run, policy: { ...run.policy, maximumFactors: 1 } }))).toBe(true)
    expect(
      Result.isFailure(decodeResearchRun({ ...run, policy: { ...run.policy, model: 'alpha-r1-82c2aa5fcdda' } })),
    ).toBe(true)
  })
  test('verifies and prices an immutable receipt containing the full approved stream', () => {
    const value = receipt(ResearchOutcome.Complete, fullTokenBudgetStreamFixture(), 4096)
    expect(Result.getOrThrow(verifyResearchReceipt(run, value))).toEqual(value)
    expect(Result.getOrThrow(researchExpensePlan(run, value)).transfers[0]?.amount).toBe(1001000002n)
  })
  test('rejects decoded response bytes above the bound even when base64 padding has spare capacity', () => {
    const bytes = Buffer.alloc(maximumResearchStreamBytes + 1)
    const value = {
      ...receipt(ResearchOutcome.Expired),
      responseBase64: bytes.toString('base64'),
      responseHash: sha256(bytes),
    }
    const {
      schemaVersion: _version,
      qualification: _qualification,
      receiptHash: _hash,
      costPicoUsd: _cost,
      ...material
    } = value
    expect(Result.isFailure(verifyResearchReceipt(run, Result.getOrThrow(sealResearchReceipt(run, material))))).toBe(
      true,
    )
  })
  test('binds all generation overrides, semantic bytes, arm and attempt identities', () => {
    for (const policy of [
      { ...run.policy, seed: 2 },
      { ...run.policy, max_tokens: 3000 },
      { ...run.policy, enable_thinking: true },
      { ...run.policy, stop: ['x'] },
    ])
      expect(Result.getOrThrow(hashResearch({ ...run, policy }))).not.toBe(id)
    for (const changed of [
      { ...run, attempt: 1 },
      { ...run, armManifestHashes: ['5'.repeat(64)] },
      { ...run, captureManifestHash: '6'.repeat(64) },
    ])
      expect(Result.getOrThrow(hashResearch(changed))).not.toBe(id)
    expect(researchRequest(run).stream_options?.include_usage).toBe(true)
    expect(researchRequest(run).messages?.[0]?.content).toContain(run.context.memory.text)
  })
  test('rejects unfrozen overrides, future context, changed bytes and unsupported free rates', () => {
    for (const changed of [
      { ...run, policy: { ...run.policy, best_of: 3 } },
      { ...run, context: { memory: { ...run.context.memory, availableAt: '1970-01-01T00:00:00.001Z' } } },
      { ...run, context: { memory: { ...run.context.memory, text: 'changed' } } },
      { ...run, costBasis: { ...run.costBasis, picoUsdPerSecond: '0' } },
      { ...run, costBasis: { ...run.costBasis, picoUsdPerSecond: (2n ** 128n / 180n + 1n).toString() } },
    ])
      expect(Result.isFailure(decodeResearchRun(changed))).toBe(true)
  })
  test('allocates integer USD_PICO without floating point or changing posted identities', () => {
    const value = receipt()
    expect(value.costPicoUsd).toBe('1001000002')
    const plan = Result.getOrThrow(researchExpensePlan(run, value))
    expect(plan.accounts).toHaveLength(2)
    expect(plan.transfers[0]?.amount).toBe(1001000002n)
    expect(plan.transfers[0]?.ledger).toBe(7002)
    expect(Result.getOrThrow(researchExpensePlan(run, value))).toEqual(plan)
    expect(Result.isFailure(verifyResearchReceipt(run, { ...value, costPicoUsd: '1' }))).toBe(true)
    expect(Result.isFailure(verifyResearchReceipt({ ...run, attempt: 1 }, value))).toBe(true)
  })
  test.each([ResearchOutcome.Expired, ResearchOutcome.Ambiguous, ResearchOutcome.Rejected])(
    'keeps %s operating costs unknown',
    (outcome) => {
      expect(receipt(outcome).costPicoUsd).toBeNull()
      expect(Result.getOrThrow(researchExpensePlan(run, receipt(outcome))).transfers).toEqual([])
    },
  )
  test('rejects resealed success receipts with inconsistent HTTP or token timing', () => {
    const {
      schemaVersion: _version,
      qualification: _qualification,
      receiptHash: _hash,
      costPicoUsd: _cost,
      ...material
    } = receipt()
    for (const changed of [
      { ...material, httpStatus: 503 },
      { ...material, servingIdentity: null },
      { ...material, servingIdentity: { ...researchServingIdentity(run.policy), checkpoint: '0'.repeat(40) } },
      { ...material, firstTokenAtMs: null },
      { ...material, firstTokenAtMs: material.completedAtMs + 1 },
    ]) {
      const resealed = Result.getOrThrow(sealResearchReceipt(run, changed))
      expect(Result.isFailure(verifyResearchReceipt(run, resealed))).toBe(true)
    }
  })
})
