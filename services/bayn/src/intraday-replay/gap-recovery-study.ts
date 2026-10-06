import { Effect, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import {
  GapEndpointKind,
  GapRecoveryFailure,
  GapRecoverySessionSchema,
  decideGapRecovery,
  gapRecoveryDefinition,
  observeGapRecoveryEndpoint,
  prepareGapRecoverySession,
} from './gap-recovery'
import { BacktestSourceManifestSchema, openBacktestSource, type BacktestSourceReceipt } from './source'

export const GapRecoveryStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.gap-recovery-study.v1'),
  session: GapRecoverySessionSchema,
  previousSource: BacktestSourceManifestSchema,
  currentSource: BacktestSourceManifestSchema,
})

export const runGapRecoveryStudy = (
  raw: unknown,
  previous: { readonly arrivalsPath: string; readonly receipt: BacktestSourceReceipt },
  current: { readonly arrivalsPath: string; readonly receipt: BacktestSourceReceipt },
) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(GapRecoveryStudyInputSchema, strictParseOptions)(raw)
    const session = yield* Effect.fromResult(prepareGapRecoverySession(input.session))
    for (const [manifest, receipt, startMs, endMs] of [
      [input.previousSource, previous.receipt, session.priorAtMs, session.priorAtMs],
      [input.currentSource, current.receipt, session.openingAtMs, session.decisionAtMs],
    ] as const) {
      if (
        manifest.transport !== 'original-capture' ||
        receipt.value.schemaVersion !== 'bayn.original-capture-replay-receipt.v1' ||
        manifest.coverageStartMs > startMs ||
        manifest.coverageEndMs < endMs
      )
        return yield* new GapRecoveryFailure({
          message: 'Gap recovery requires both original-capture intervals to cover their fixed observations',
        })
    }
    const runId = yield* Effect.fromResult(
      canonicalHashV1Result({
        input,
        definition: gapRecoveryDefinition,
        previousReceiptHash: previous.receipt.contentHash,
        currentReceiptHash: current.receipt.contentHash,
      }),
    )
    const priorEndpoint = yield* Effect.gen(function* () {
      const source = yield* openBacktestSource(previous.arrivalsPath, input.previousSource, runId, previous.receipt)
      yield* source.advanceTo(session.priorAtMs)
      const endpoint = yield* Effect.fromResult(
        observeGapRecoveryEndpoint(yield* source.cursor, session, GapEndpointKind.PreviousClose),
      )
      yield* source.finish
      return endpoint
    }).pipe(Effect.scoped)
    const result = yield* Effect.gen(function* () {
      const source = yield* openBacktestSource(current.arrivalsPath, input.currentSource, runId, current.receipt)
      yield* source.advanceTo(session.openingAtMs)
      const opening = yield* Effect.fromResult(
        observeGapRecoveryEndpoint(yield* source.cursor, session, GapEndpointKind.Opening),
      )
      yield* source.advanceTo(session.decisionAtMs)
      const decision = yield* Effect.fromResult(
        decideGapRecovery(priorEndpoint, opening, yield* source.cursor, session),
      )
      yield* source.finish
      return decision
    }).pipe(Effect.scoped)
    const report = {
      schemaVersion: 'bayn.gap-recovery-study-report.v1',
      classification: 'ORIGINAL_RECEIPT_DECISION_REPLAY',
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      runId,
      input,
      previousReceipt: previous.receipt,
      currentReceipt: current.receipt,
      decision: result,
      limitation:
        'Two verified supplied intervals and a reproducible decision do not establish live coverage, prospective performance, calibrated execution, profitability or trading authority.',
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
