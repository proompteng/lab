import { entryProviderFixture } from './entry-inference.test-support'
import { expect, test } from 'bun:test'
import { Effect, Exit, Layer, Logger, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { operationalError } from '../errors'
import { JevClient } from './client'
import {
  EntryInferenceJournal,
  EntrySourceFeasibilityReason,
  evaluateEntrySourceFeasibility,
  hasFeasibleEntrySource,
  prepareClaimedEntry,
} from './entry-inference'
import { makeNativeChartEvidence } from './chart-evidence'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { entryHandoffDiagnostic, logCommittedEntryHandoff } from './entry-inference-diagnostics'
import type { EntryHandoff } from './entry-inference'
import { entryCompletionFixture, entryEvaluationRequestFixture } from './entry-inference.test-support'
import { JevEvaluationStore, makeJevDispatch } from './evaluation'
import { makeJevEvaluationRequest, type JevEvaluationRequest } from './evidence'
import { prepareEntryInferenceInput } from './entry-inference-input'

const noQuantityRequest = () => {
  const original = entryEvaluationRequestFixture()
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...original.request,
      funding: { ...original.request.funding, capitalMicros: '1' },
    }),
  )
  return Result.getOrThrow(
    makeJevEvaluationRequest({
      schemaVersion: original.schemaVersion,
      cycleId: original.cycleId,
      authorityGenerationHash: original.authorityGenerationHash,
      snapshotId: original.snapshotId,
      symbol: original.symbol,
      observedAt: original.observedAt,
      expiresAt: original.expiresAt,
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
}

const prepare = (request: JevEvaluationRequest) =>
  Result.getOrThrow(
    prepareClaimedEntry({
      requestId: request.requestId,
      input: request.request,
      observedAt: request.observedAt,
      expiresAt: request.expiresAt,
      claimedAt: request.observedAt,
    }),
  )

const quietCryptoRequest = () => {
  const original = entryEvaluationRequestFixture()
  const symbol = 'ETH/USD'
  const bars = original.request.chartSource.bars.map((bar) => ({
    ...bar,
    open: 100,
    high: 100.03,
    low: 99.99,
    close: 100,
  }))
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...original.request,
      chartSource: { ...original.request.chartSource, symbol, bars },
      numericalState: { ...original.request.numericalState, candidate: { symbol, bars1m: bars } },
      funding: { ...original.request.funding, bidMicros: '100000000', askMicros: '100010000' },
    }),
  )
  return Result.getOrThrow(
    makeJevEvaluationRequest({
      schemaVersion: original.schemaVersion,
      cycleId: original.cycleId,
      authorityGenerationHash: original.authorityGenerationHash,
      snapshotId: original.snapshotId,
      symbol,
      observedAt: original.observedAt,
      expiresAt: original.expiresAt,
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
}

test.each([
  {
    fixture: entryEvaluationRequestFixture,
    feasible: true,
    reason: EntrySourceFeasibilityReason.Feasible,
    requestHash: '61550e4d90b8e028f0328faa79906392d1c0b7316b4265ea75a4370cceb2f793',
    claimHash: 'c282d8c7152987bb100de0cbc984dd6fac7275bb664d0e17bf24481506a6836d',
  },
  {
    fixture: noQuantityRequest,
    feasible: false,
    reason: EntrySourceFeasibilityReason.NoExecutableQuantity,
    requestHash: '1e662df92b8b3c5fd0ce3539e9b6d762a8d9bae9cb27056fc6d708e4ff6195a0',
    claimHash: null,
  },
  {
    fixture: quietCryptoRequest,
    feasible: false,
    reason: EntrySourceFeasibilityReason.NoFundedSourceStructure,
    requestHash: '51dbdf7d92723006ac65faf481f2bca765035af9bfbe00f0980b0d3e7c55618e',
    claimHash: null,
  },
])(
  'pins current v37 feasibility and identity oracles for $reason',
  ({ fixture, feasible, reason, requestHash, claimHash }) => {
    const request = fixture()
    const prepared = prepare(request)
    const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
    expect(Result.getOrThrow(hasFeasibleEntrySource(request.request, chart))).toBe(feasible)
    expect(prepared.sourceFeasibility).toMatchObject({ feasible, reason })
    expect(request.requestHash).toBe(requestHash)
    expect(prepared.visualClaim?.claimHash ?? null).toBe(claimHash)
    if (!feasible)
      expect(prepared.sourceFeasibility).toMatchObject({
        supportBarCount: 0,
        resistanceBarCount: 0,
        baseWindowCount: 0,
      })
  },
)

test('feasibility diagnostic preserves invalid economics as failure rather than an abstention', () => {
  const request = entryEvaluationRequestFixture()
  const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
  const invalid = { ...request.request, funding: { ...request.request.funding, askMicros: '0' } }
  const diagnostic = evaluateEntrySourceFeasibility(invalid, chart)
  const boolean = hasFeasibleEntrySource(invalid, chart)
  expect(Result.isFailure(diagnostic)).toBe(true)
  expect(Result.isFailure(boolean)).toBe(true)
  if (Result.isFailure(diagnostic) && Result.isFailure(boolean)) {
    expect(diagnostic.failure._tag).toBe('JevContractError')
    expect(boolean.failure.message).toBe(diagnostic.failure.message)
  }
})

test.each(['REQUEST', 'TRANSPORT', 'STATUS', 'RESPONSE', 'DEADLINE'] as const)(
  'projects only the closed visual failure category %s',
  async (category: NonNullable<EntryHandoff['disposition'] & { status: 'VISUAL_FAILED' }>['failure']['category']) => {
    const request = entryEvaluationRequestFixture()
    const handoff: EntryHandoff = {
      ...entryCompletionFixture(request).handoff,
      disposition: {
        status: 'VISUAL_FAILED',
        failure: {
          category,
          httpStatus: 429,
          responseHash: 'f'.repeat(64),
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 20,
            total_tokens: 120,
          },
        },
      },
    }
    const before = JSON.stringify(handoff)
    const feasibility = prepare(request).sourceFeasibility
    const diagnostic = entryHandoffDiagnostic(request.cycleId, handoff, feasibility)
    expect(diagnostic).toMatchObject({ disposition: 'VISUAL_FAILED', visualFailureCategory: category })
    expect(JSON.stringify(handoff)).toBe(before)
    for (const forbidden of ['httpStatus', 'responseHash', 'usage', 'input_tokens', '429', 'f'.repeat(64)])
      expect(JSON.stringify(diagnostic)).not.toContain(forbidden)
    const exit = await Effect.runPromiseExit(
      logCommittedEntryHandoff(request.cycleId, handoff, feasibility).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(() => {
              throw new Error('diagnostic sink unavailable')
            }),
          ]),
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(JSON.stringify(handoff)).toBe(before)
  },
)

test('projects authentic ready and unfunded derivations without provider or financial material', () => {
  const request = entryEvaluationRequestFixture()
  const ready = entryCompletionFixture(request).handoff
  expect(ready.disposition.status).toBe('READY')
  expect(ready.handoffHash).toBe('2d147d929d22967679165be04c371c08e9d141606c439ab6b8904db30fa3ff29')
  const diagnostic = entryHandoffDiagnostic(request.cycleId, ready, prepare(request).sourceFeasibility)
  expect(diagnostic.disposition).toBe('READY')
  expect(diagnostic.proposalCount).toBeGreaterThan(0)
  expect(Object.keys(diagnostic).sort()).toEqual([
    'cycleId',
    'disposition',
    'event',
    'handoffHash',
    'proposalCount',
    'rejectionCounts',
    'requestId',
    'sourceFeasibility',
  ])
  const unfunded = entryCompletionFixture(noQuantityRequest()).handoff
  if (ready.disposition.status !== 'READY') throw new Error('Expected a ready fixture')
  const otherHandoffs: readonly EntryHandoff[] = [
    ready,
    unfunded,
    { ...ready, disposition: { status: 'SOURCE_INFEASIBLE' } },
    {
      ...ready,
      disposition: {
        status: 'PREPARATION_FAILED',
        visual: ready.disposition.visual,
        reason: 'DERIVATION_CONTRACT',
      },
    },
  ]
  for (const handoff of otherHandoffs)
    expect(entryHandoffDiagnostic(request.cycleId, handoff, prepare(request).sourceFeasibility)).not.toHaveProperty(
      'visualFailureCategory',
    )
  expect(
    entryHandoffDiagnostic(request.cycleId, unfunded, prepare(noQuantityRequest()).sourceFeasibility),
  ).toMatchObject({
    disposition: 'NO_FUNDED_PROPOSALS',
    proposalCount: 0,
    rejectionCounts: [{ reason: 'NO_BUY_QUANTITY', count: 2 }],
  })
  const serialized = JSON.stringify(diagnostic)
  for (const forbidden of [
    'response',
    'usage',
    'funding',
    'capitalMicros',
    'bidMicros',
    'askMicros',
    'questions',
    'bars',
  ])
    expect(serialized).not.toContain(forbidden)
})

const runSourceInfeasible = async (
  mode: 'success' | 'commit-failure' | 'replay' | 'logger-defect',
  request = noQuantityRequest(),
) => {
  const claim = {
    requestId: request.requestId,
    observedAt: request.observedAt,
    claimedAt: request.observedAt,
    expiresAt: request.expiresAt,
    input: request.request,
  }
  const prepared = Result.getOrThrow(prepareClaimedEntry(claim))
  expect(prepared.visualClaim).toBeNull()
  const messages: unknown[] = []
  let committed = false
  const logger = Logger.make(({ message }) => {
    expect(committed).toBe(true)
    if (mode === 'logger-defect') throw new Error('diagnostic sink unavailable')
    messages.push(...(Array.isArray(message) ? message : [message]))
  })
  const layer = Layer.mergeAll(
    TestClock.layer(),
    Logger.layer([logger]),
    Layer.succeed(EntryInferenceJournal, {
      recordVisualClaims: () => Effect.die('Source-infeasible entry must not dispatch'),
      recordTransitions: (transitions) =>
        Effect.gen(function* () {
          if (mode === 'commit-failure')
            return yield* operationalError({
              component: 'database',
              operation: 'test-commit',
              message: 'commit failed',
            })
          committed = true
          return transitions.map(() => ({ requestId: request.requestId, dispatchAllowed: mode !== 'replay' }))
        }),
    }),

    Layer.succeed(
      JevClient,
      entryProviderFixture(
        { evaluate: () => Effect.die('Unexpected paid judgment call') },
        { evaluate: () => Effect.die('Unexpected paid visual call') },
      ),
    ),
    Layer.succeed(JevEvaluationStore, {
      read: () => Effect.die('Unexpected read'),
      abandon: () => Effect.die('Unexpected abandon'),
      recordAll: () => Effect.die('Unexpected partial receipt'),
    }),
  )
  const exit = await Effect.runPromiseExit(
    evaluateClaimedEntryInferences([
      makeJevDispatch({
        request,
        claimedAt: claim.claimedAt,
        visualClaim: prepared.visualClaim,
      }),
    ]).pipe(Effect.provide(layer)),
  )
  return { exit, messages, request }
}

test('source-infeasible committed handoff emits one bounded correlated event without provider calls', async () => {
  const { exit, messages, request } = await runSourceInfeasible('success')
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    event: 'bayn.entry-handoff-diagnostic.v1',
    cycleId: request.cycleId,
    requestId: request.requestId,
    disposition: 'SOURCE_INFEASIBLE',
    proposalCount: 0,
    rejectionCounts: [],
    sourceFeasibility: {
      reason: 'NO_EXECUTABLE_QUANTITY',
      supportBarCount: 0,
      resistanceBarCount: 0,
      baseWindowCount: 0,
    },
  })
})

test('quiet crypto source logs no funded structure, not a quantity failure, after commit', async () => {
  const { exit, messages } = await runSourceInfeasible('success', quietCryptoRequest())
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    disposition: 'SOURCE_INFEASIBLE',
    sourceFeasibility: {
      reason: 'NO_FUNDED_SOURCE_STRUCTURE',
      supportBarCount: 0,
      resistanceBarCount: 0,
      baseWindowCount: 0,
    },
  })
})

test.each(['commit-failure', 'replay'] as const)('%s emits no newly committed handoff diagnostic', async (mode) => {
  const { exit, messages } = await runSourceInfeasible(mode)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(messages).toEqual([])
})

test('diagnostic logger defect does not change a committed handoff completion', async () => {
  const { exit, messages } = await runSourceInfeasible('logger-defect')
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isSuccess(exit)) expect(exit.value[0]?.handoff.disposition.status).toBe('SOURCE_INFEASIBLE')
  expect(messages).toEqual([])
})
