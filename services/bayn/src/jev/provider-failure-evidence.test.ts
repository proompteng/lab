import { expect, test } from 'bun:test'
import { Effect, Redacted, Result, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import { IsoDateSchema } from '../schemas'
import { InferenceUsageStatus } from '../inference-costs'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes, verifyInferenceExpenseQuote } from '../inference-expense'
import { JevClient, JevClientLive } from './client'
import { JevOutcome, type JevEvaluationReceipt } from './evidence'
import { JevEvaluationStore } from './evaluation'
import { admitAndEvaluateFixture } from './evaluation.test-support'
import { EntryInferenceJournal, type EntryHandoff } from './entry-inference'
import { entryEvaluationRequestFixture, entryProviderFixture } from './entry-inference.test-support'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { decodeStagedCheckpoint, type StagedDispatchClaim, type StagedTerminalReceipt } from './staged-checkpoint'

test.each([
  { stage: 'CHART', metered: false },
  { stage: 'CHART', metered: true },
  { stage: 'JEV', metered: false },
  { stage: 'JEV', metered: true },
] as const)(
  'HTTP 529 diagnostics survive $stage journal and cost evidence with metered=$metered',
  async ({ stage, metered }) => {
    const request = entryEvaluationRequestFixture()
    const claims: StagedDispatchClaim[] = []
    const terminals: StagedTerminalReceipt[] = []
    const handoffs: EntryHandoff[] = []
    const receipts: JevEvaluationReceipt[] = []
    const diagnostics = {
      schemaVersion: 'bayn.jev-provider-diagnostics.v1',
      requestId: 'provider-529-fixture',
      errorType: 'overloaded_error',
      retryAfter: { kind: 'DELAY', seconds: 3 },
    }
    const usage = { input_tokens: 10, output_tokens: 1 }
    let calls = 0
    const http = HttpClient.make((providerRequest) => {
      calls++
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          providerRequest,
          new Response(
            JSON.stringify({
              ...(metered ? { model: 'jev-1.14.0', usage } : {}),
              error: { type: 'overloaded_error', message: 'private provider explanation' },
              authorization: 'private-api-key',
            }),
            { status: 529, headers: { 'request-id': 'provider-529-fixture', 'retry-after': '3' } },
          ),
        ),
      )
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(request.observedAt))
        const provider = yield* JevClient
        return yield* admitAndEvaluateFixture({ request, claimedAt: request.observedAt }).pipe(
          Effect.result,
          Effect.provideService(JevClient, stage === 'CHART' ? provider : entryProviderFixture(provider)),
        )
      }).pipe(
        Effect.provide(JevClientLive(Redacted.make('private-api-key'), 1000)),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(EntryInferenceJournal, {
          recordVisualClaims: (inputs) =>
            Effect.sync(() => {
              claims.push(...inputs)
              return inputs.map((claim) => ({ requestId: claim.requestId, dispatchAllowed: true }))
            }),
          recordTransitions: (inputs) =>
            Effect.sync(() =>
              inputs.map((input) => {
                if (input.terminal !== null) terminals.push(input.terminal)
                if (input.successor.kind === 'HANDOFF') handoffs.push(input.successor.handoff)
                return {
                  requestId:
                    input.terminal?.requestId ??
                    (input.successor.kind === 'HANDOFF' ? input.successor.handoff.requestId : ''),
                  dispatchAllowed: true,
                }
              }),
            ),
        }),
        Effect.provideService(JevEvaluationStore, {
          read: () => Effect.die('Unexpected read'),
          abandon: () => Effect.die('Unexpected abandonment'),
          recordAll: (records) =>
            Effect.sync(
              () =>
                new Map(
                  records.map(({ receipt }) => {
                    receipts.push(receipt)
                    return [
                      request.requestId,
                      Result.getOrThrow(
                        makeJevResolution(request, receipt, {
                          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                          requestId: request.requestId,
                          status: JevResolutionStatus.Recorded,
                          receiptHash: receipt.receiptHash,
                        }),
                      ),
                    ] as const
                  }),
                ),
            ),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(calls).toBe(1)
    expect(receipts).toHaveLength(1)
    const receipt = receipts[0]
    const handoff = handoffs[0]
    if (receipt?.outcome.status !== JevOutcome.Completed || handoff === undefined)
      throw new Error('Expected a committed failed inference')
    const completion = receipt.outcome.completion
    const failure =
      stage === 'CHART'
        ? completion.handoff.disposition.status === 'VISUAL_FAILED'
          ? completion.handoff.disposition.failure
          : null
        : completion.jev.status === 'FAILED'
          ? completion.jev
          : null
    expect(failure).toMatchObject({
      httpStatus: 529,
      responseHash: metered ? Result.getOrThrow(canonicalHashV1Result({ model: 'jev-1.14.0', usage })) : null,
      usage: metered ? usage : null,
      providerDiagnostics: diagnostics,
    })
    expect(JSON.stringify(receipt)).not.toContain('private-api-key')
    expect(JSON.stringify(receipt)).not.toContain('private provider explanation')
    const checkpoint = { claims, terminals, skips: [] }
    expect(Result.getOrThrow(decodeStagedCheckpoint(request, JSON.parse(JSON.stringify(checkpoint))))).toEqual(
      checkpoint,
    )
    const source = {
      accountId: 'provider-failure-cost-test',
      sessionDate: Result.getOrThrow(Schema.decodeUnknownResult(IsoDateSchema)(request.observedAt.slice(0, 10))),
      asOf: request.expiresAt,
      requestId: request.requestId,
      cycleId: request.cycleId,
      authorityGenerationHash: request.authorityGenerationHash,
      request,
      receipt,
      resolution: Result.getOrThrow(
        makeJevResolution(request, receipt, {
          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
          requestId: request.requestId,
          status: JevResolutionStatus.Recorded,
          receiptHash: receipt.receiptHash,
        }),
      ),
      handoff,
      stagedCheckpoint: checkpoint,
    }
    const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
    for (const quote of quotes) expect(Result.isSuccess(verifyInferenceExpenseQuote(source, quote))).toBe(true)
    const failed = quotes.find((quote) => 'stage' in quote.line && quote.line.stage === stage)
    expect(failed?.line.usageStatus).toBe(metered ? InferenceUsageStatus.Rejected : InferenceUsageStatus.Unknown)
    expect(failed?.line.estimatedCostPicoUsd).toBe(metered ? '420000' : null)
    if (stage === 'CHART')
      expect(quotes.find((quote) => 'stage' in quote.line && quote.line.stage === 'JEV')?.line.usageStatus).toBe(
        InferenceUsageStatus.NotDispatched,
      )
  },
)
