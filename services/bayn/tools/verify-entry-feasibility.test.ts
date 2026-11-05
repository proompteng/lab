import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, FileSystem, Result } from 'effect'
import { gzipSync } from 'node:zlib'

import {
  entryCompletionFixture,
  entryEvaluationRequestFixture,
  stagedCheckpointFixture,
} from '../src/jev/entry-inference.test-support'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from '../src/jev/evidence'
import { JevFailure } from '../src/jev/contract'
import { prepareEntryInferenceInput } from '../src/jev/entry-inference-input'
import { JevResolutionStatus, makeJevResolution } from '../src/jev/resolution'
import {
  entryCompletionFixture as retainedCompletionFixture,
  entryEvaluationRequestFixture as retainedRequestFixture,
  makeFundedEvaluationReceipt,
} from '../src/jev/funded-entry.test-support'
import { verifyEntryFeasibility } from './verify-entry-feasibility'

const stagedRow = (symbol: string) => {
  const request = entryEvaluationRequestFixture(undefined, symbol)
  const completion = entryCompletionFixture(request)
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: request.observedAt,
      outcome: { status: JevOutcome.Completed, completion },
    }),
  )
  const resolution = Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  )
  return {
    request,
    receipt,
    resolution,
    handoff: completion.handoff,
    stagedCheckpoint: stagedCheckpointFixture(request),
  }
}

test('verifies current staged equity and crypto evidence through the native dispatch probe without provider I/O', async () => {
  const rows = [stagedRow('AAPL'), stagedRow('ETH/USD')]
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const input = `${directory}/evidence.ndjson.gz`
        const output = `${directory}/report.json`
        yield* fs.writeFile(input, gzipSync(rows.map((row) => JSON.stringify(row)).join('\n')))
        yield* verifyEntryFeasibility(input, output)
        const report = JSON.parse(yield* fs.readFileString(output))
        expect(report.requests).toBe(2)
        expect(report.possibleChartBranches).toBe(2)
        expect(report.actualProviderCalls).toBe(0)
        expect(report.originalFundedSourcesStillFeasible).toBe(2)
        expect(report.results[0].originalJevQuestionNames).toEqual([
          'equity_support_recovery_confirmed',
          'equity_support_recovery_stop_invalidates',
          'equity_base_breakout_confirmed',
          'equity_base_breakout_stop_invalidates',
        ])
        expect(report.results[1].originalJevQuestionNames).toContain('crypto_support_recovery_target_obstructed')
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- each test owns its scoped filesystem
      Effect.provide(NodeServices.layer),
    ),
  )
})

test('rejects current evidence without its original stage checkpoint and leaves no success report', async () => {
  const { stagedCheckpoint: _, ...row } = stagedRow('AAPL')
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const input = `${directory}/evidence.ndjson.gz`
        const output = `${directory}/report.json`
        yield* fs.writeFile(input, gzipSync(JSON.stringify(row)))
        const result = yield* Effect.exit(verifyEntryFeasibility(input, output))
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* fs.exists(output)).toBe(false)
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- each test owns its scoped filesystem
      Effect.provide(NodeServices.layer),
    ),
  )
})

test('proves an unfundable current source skips every provider stage and reports zero inference cost', async () => {
  const { requestId: _, ...material } = entryEvaluationRequestFixture()
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...material.request,
      funding: { ...material.request.funding, bidMicros: '500000000', askMicros: '500020000' },
    }),
  )
  const request = Result.getOrThrow(
    makeJevEvaluationRequest({ ...material, request: prepared.input, requestHash: prepared.requestHash }),
  )
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: request.expiresAt,
      outcome: { status: JevOutcome.Failed, failure: JevFailure.NotDispatched },
    }),
  )
  const row = {
    request,
    receipt,
    handoff: null,
    resolution: null,
    stagedCheckpoint: { claims: [], terminals: [], skips: [] },
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const input = `${directory}/evidence.ndjson.gz`
        const output = `${directory}/report.json`
        yield* fs.writeFile(input, gzipSync(JSON.stringify(row)))
        yield* verifyEntryFeasibility(input, output)
        const report = JSON.parse(yield* fs.readFileString(output))
        expect(report.sourceInfeasibleSkips).toBe(1)
        expect(report.possibleChartBranches).toBe(0)
        expect(report.actualProviderCalls).toBe(0)
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- each test owns its scoped filesystem
      Effect.provide(NodeServices.layer),
    ),
  )
})

test('retains the original financial-only question contract when probing a historical funded source', async () => {
  const request = retainedRequestFixture()
  const completion = retainedCompletionFixture(request)
  const receipt = Result.getOrThrow(
    makeFundedEvaluationReceipt(request, {
      startedAt: request.observedAt,
      completedAt: request.observedAt,
      outcome: { status: JevOutcome.Completed, completion },
    }),
  )
  const row = { request, receipt, handoff: completion.handoff, resolution: null }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const input = `${directory}/evidence.ndjson.gz`
        const output = `${directory}/report.json`
        yield* fs.writeFile(input, gzipSync(JSON.stringify(row)))
        yield* verifyEntryFeasibility(input, output)
        const report = JSON.parse(yield* fs.readFileString(output))
        expect(report.requests).toBe(1)
        expect(report.originalFundedSourcesStillFeasible).toBe(1)
        expect(report.actualProviderCalls).toBe(0)
        expect(report.results[0].originalInputVersion).toBe('bayn.entry-inference-input.v4')
        expect(report.results[0].originalJevQuestionNames).toContain('support_recovery_target_obstructed')
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- each test owns its scoped filesystem
      Effect.provide(NodeServices.layer),
    ),
  )
})
