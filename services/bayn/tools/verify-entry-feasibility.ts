import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Exit, FileSystem, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { gunzipSync } from 'node:zlib'

import { canonicalHashV1Result } from '../src/hash'
import { instrumentMarket, MarketKind } from '../src/instruments'
import { makeChartDecisionsRequest } from '../src/jev/chart-questions'
import { IsoDateSchema } from '../src/schemas'
import { makeNativeChartEvidence, makeRetainedChartEvidenceV1 } from '../src/jev/chart-evidence'
import { JevClient } from '../src/jev/client'
import { DecisionsClient } from '../src/jev/decisions'
import { decodeEntryInferenceCompletion } from '../src/jev/entry-inference-evidence'
import { prepareEntryInferenceInput } from '../src/jev/entry-inference-input'
import {
  deriveEntryDispositionForChart,
  EntryInferenceJournal,
  evaluateClaimedEntryInference,
} from '../src/jev/entry-inference'
import { makeJevEvaluationReceipt, makeJevEvaluationRequest, JevOutcome } from '../src/jev/evidence'
import { JevResolutionStatus, makeJevResolution } from '../src/jev/resolution'
import { readSequentialInferenceCostEvidence } from '../src/jev/sequential-inference-cost-evidence'
import { makeRetainedFundedEntryJudgmentRequest as makeEntryJudgmentRequest } from '../src/jev/retained-funded-entry-questions'
import { makeRetainedEntryJudgmentRequest } from '../src/jev/retained-entry-questions'
import { defaultJevProtocolDocument } from '../src/jev/protocol'
import { jevEntryEconomics } from '../src/jev/entry-economics'
import type { StagedCheckpoint } from '../src/jev/staged-checkpoint'
import { InferenceUsageStatus } from '../src/inference-costs'
import { makeInferenceExpenseQuotes } from '../src/inference-expense'

const Row = Schema.Struct({
  request: Schema.Unknown,
  receipt: Schema.Unknown,
  handoff: Schema.Unknown,
  resolution: Schema.Unknown,
})
class VerificationError extends Data.TaggedError('EntryFeasibilityVerificationError')<{ readonly message: string }> {}
const fail = (message: string) => Effect.fail(new VerificationError({ message }))

const verify = Effect.gen(function* () {
  const [inputPath, outputPath] = process.argv.slice(2)
  if (inputPath === undefined || outputPath === undefined || process.argv.length !== 4)
    return yield* fail('Usage: node verify-entry-feasibility.mjs <existing-export.ndjson.gz> <new-output.json>')
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(outputPath)) return yield* fail('Verification output already exists')
  const bytes = yield* fs.readFile(inputPath)
  const text = yield* Effect.try(() => gunzipSync(bytes).toString('utf8'))
  const results = []
  let skips = 0
  let chartBranches = 0
  let fundedRequests = 0
  for (const line of text.trim().split('\n')) {
    const raw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Row))(line)
    const original = yield* Effect.fromResult(readSequentialInferenceCostEvidence(raw))
    const input = original.request.request
    const chart = yield* Effect.fromResult(
      input.schemaVersion === 'bayn.entry-inference-input.v1'
        ? makeRetainedChartEvidenceV1(input.chartSource)
        : makeNativeChartEvidence(input.chartSource),
    )
    const saved = original.handoff?.disposition
    if (saved?.status !== 'READY' && saved?.status !== 'NO_FUNDED_PROPOSALS')
      return yield* fail('The preservation cohort must contain completed recorded chart evaluations')
    const reproduced = yield* Effect.fromResult(
      deriveEntryDispositionForChart(
        input,
        saved.visual,
        chart,
        saved.assessments,
        input.schemaVersion === 'bayn.entry-inference-input.v3' ||
          input.schemaVersion === 'bayn.entry-inference-input.v4'
          ? makeEntryJudgmentRequest
          : makeRetainedEntryJudgmentRequest,
      ),
    )
    const expectedHash = yield* Effect.fromResult(canonicalHashV1Result(saved.evaluation))
    const actualHash = yield* Effect.fromResult(canonicalHashV1Result(reproduced.evaluation))
    if (expectedHash !== actualHash) return yield* fail('The final native proposal evaluation changed')
    // Original model responses retain their contracts; the dispatch probe never calls either provider.
    const protocol = {
      ...input.protocol,
      schemaVersion: 'bayn.jev.protocol.v28' as const,
      entryQuestionPolicyHash: defaultJevProtocolDocument.entryQuestionPolicyHash,
    }
    const funding = {
      ...input.funding,
      cryptoFeeTier:
        instrumentMarket(input.chartSource.symbol) === MarketKind.Equity ? null : input.funding.cryptoFeeTier,
    }
    const economics = yield* Effect.fromResult(
      jevEntryEconomics({
        protocol,
        symbol: input.chartSource.symbol,
        bidMicros: BigInt(funding.bidMicros),
        askMicros: BigInt(funding.askMicros),
        capitalMicros: funding.capitalMicros,
        cryptoFeeTier: funding.cryptoFeeTier,
      }),
    )
    const current = yield* Effect.fromResult(
      prepareEntryInferenceInput({
        ...input,
        schemaVersion: 'bayn.entry-inference-input.v5',
        protocol,
        funding,
        numericalState: { ...input.numericalState, entryEconomics: economics },
      }),
    )
    const visualSource = yield* Effect.fromResult(
      makeChartDecisionsRequest({ chart, protocol: current.input.protocol, funding: current.input.funding }),
    )
    const feasible = visualSource.sourceFeasible
    if (saved.evaluation.proposals.length > 0) {
      if (!feasible) return yield* fail('Feasibility gate drops an originally funded proposal')
      fundedRequests++
    }
    const { requestId: _originalId, ...material } = original.request
    const request = yield* Effect.fromResult(
      makeJevEvaluationRequest({
        ...material,
        schemaVersion: 'bayn.jev-evaluation-request.v3',
        request: current.input,
        requestHash: current.requestHash,
      }),
    )
    let attemptedChartBranches = 0
    let attemptedJevBranches = 0
    let committedHandoffs = 0
    const checkpoint: {
      claims: StagedCheckpoint['claims'][number][]
      terminals: StagedCheckpoint['terminals'][number][]
      skips: StagedCheckpoint['skips'][number][]
    } = { claims: [], terminals: [], skips: [] }
    const branch = yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
      Effect.andThen(
        evaluateClaimedEntryInference({
          requestId: request.requestId,
          input: request.request,
          observedAt: request.observedAt,
          expiresAt: request.expiresAt,
          claimedAt: request.observedAt,
        }),
      ),
      Effect.provideService(EntryInferenceJournal, {
        recordVisualClaim: (claim) =>
          Effect.sync(() => {
            checkpoint.claims.push(claim)
            return { dispatchAllowed: true }
          }),
        recordVisualTerminal: (terminal) =>
          Effect.sync(() => {
            checkpoint.terminals.push(terminal)
          }),
        recordHandoff: (handoff) =>
          Effect.sync(() => {
            if (handoff.baseStart?.status === 'NOT_REQUESTED') checkpoint.skips.push(handoff.baseStart.skip)
            committedHandoffs++
            return { dispatchAllowed: true }
          }),
      }),
      Effect.provideService(DecisionsClient, {
        evaluate: () =>
          Effect.sync(() => {
            attemptedChartBranches++
          }).pipe(Effect.andThen(Effect.die('OFFLINE_CHART_BRANCH_SENTINEL'))),
      }),
      Effect.provideService(JevClient, {
        evaluate: () =>
          Effect.sync(() => {
            attemptedJevBranches++
          }).pipe(Effect.andThen(Effect.die('OFFLINE_JEV_BRANCH_SENTINEL'))),
      }),
      Effect.exit,
      // @effect-diagnostics-next-line strictEffectProvide:off -- the offline command isolates each recorded claim's clock
      Effect.provide(TestClock.layer()),
    )
    if (attemptedJevBranches !== 0) return yield* fail('Unexpected dependent provider branch')
    if (!feasible) {
      if (!Exit.isSuccess(branch) || attemptedChartBranches !== 0 || committedHandoffs !== 1)
        return yield* fail('An impossible source was dispatched or not committed exactly once')
      const completion = yield* Effect.fromResult(
        decodeEntryInferenceCompletion(
          {
            requestId: request.requestId,
            input: request.request,
            observedAt: request.observedAt,
            expiresAt: request.expiresAt,
          },
          branch.value,
        ),
      )
      if (completion.handoff.disposition.status !== 'SOURCE_INFEASIBLE' || completion.jev.status !== 'NOT_REQUESTED')
        return yield* fail('The skip result fabricates a provider outcome')
      const receipt = yield* Effect.fromResult(
        makeJevEvaluationReceipt(request, {
          schemaVersion: 'bayn.jev-evaluation-receipt.v3',
          requestId: request.requestId,
          startedAt: request.observedAt,
          completedAt: completion.completedAt,
          outcome: { status: JevOutcome.Completed, completion },
        }),
      )
      const resolution = yield* Effect.fromResult(
        makeJevResolution(request, receipt, {
          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
          requestId: request.requestId,
          status: JevResolutionStatus.Recorded,
          receiptHash: receipt.receiptHash,
        }),
      )
      const quotes = yield* Effect.fromResult(
        makeInferenceExpenseQuotes(
          {
            request,
            receipt,
            handoff: completion.handoff,
            stagedCheckpoint: checkpoint,
            resolution,
            requestId: request.requestId,
            cycleId: request.cycleId,
            authorityGenerationHash: request.authorityGenerationHash,
            accountId: 'offline-source-feasibility-proof',
            sessionDate: yield* Schema.decodeUnknownEffect(IsoDateSchema)(request.observedAt.slice(0, 10)),
            asOf: request.expiresAt,
          },
          { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
        ),
      )
      if (
        quotes.length !== 3 ||
        quotes.some(
          (q) => q.line.usageStatus !== InferenceUsageStatus.NotDispatched || q.line.estimatedCostPicoUsd !== '0',
        )
      )
        return yield* fail(
          `An undispatched provider stage is not priced as zero: ${JSON.stringify(
            quotes.map(({ line }) => ({
              stage: 'stage' in line ? line.stage : null,
              usageStatus: line.usageStatus,
              estimatedCostPicoUsd: line.estimatedCostPicoUsd,
            })),
          )}`,
        )
      skips++
    } else {
      if (!Exit.isFailure(branch) || attemptedChartBranches !== 1 || committedHandoffs !== 0)
        return yield* fail('A possible source did not reach the terminating offline chart sentinel')
      chartBranches++
    }
    results.push({
      originalRequestId: original.request.requestId,
      originalInputVersion: input.schemaVersion,
      projectedCurrentRequestId: request.requestId,
      feasible,
      originalEvaluationHash: expectedHash,
      reproducedRetainedEvaluationHash: actualHash,
      projectedEntryPriceCeilingMicros: economics?.maximumEntryPriceMicros ?? null,
      originalFundedProposalIds: saved.evaluation.proposals.map((p) => p.proposalId),
      offlineChartSentinelBranches: attemptedChartBranches,
      actualProviderCalls: 0,
    })
  }
  const report = {
    schemaVersion: 'bayn.entry-feasibility-verification.v2',
    requests: results.length,
    sourceInfeasibleSkips: skips,
    possibleChartBranches: chartBranches,
    retainedFundedSourcesStillFeasible: fundedRequests,
    actualProviderCalls: 0,
    inputProjection:
      'Same source, observed quotes, capital and fees. The offline dispatch probe recomputes v28 entry economics and its inference-ask cap. Historical model responses and proposal evaluations retain their original contracts and are never used as current judgments.',
    results,
  }
  yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
})

if (import.meta.main)
  NodeRuntime.runMain(
    verify.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI entry point owns filesystem resources
      Effect.provide(NodeServices.layer),
    ),
  )
