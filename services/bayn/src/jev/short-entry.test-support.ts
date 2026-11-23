import { Result } from 'effect'
import { shortEligibilityFixture } from '../execution/equity-short.test-support'
import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, JevCandidatePlanStatus, makeJevBatchResult } from './batch'
import { decodeJevResponse, prepareJevRequest } from './contract'
import { decideJevEntry } from './decision'
import { entryCompletionFixture } from './entry-inference.test-support'
import { makeJevEvaluationReceipt, JevOutcome } from './evidence'
import { nativeJevBatchResult, nativeJevFixture } from './native.test-support'
import { makeJevObservation } from './observation'
import { JevPurpose } from './portfolio'
import { defaultJevProtocolDocument } from './protocol'
import { makeJevTradingSignalBatch } from './trading-signals'

/** Synthetic provider responses exercise the actual native receipt, selection and execution contracts. */
export const shortNativeEntryFixture = (
  accountId = 'jev-native-short-test',
  protocolDocument: unknown = defaultJevProtocolDocument,
) =>
  Result.gen(function* () {
    const native = nativeJevFixture(
      JevPurpose.Entry,
      undefined,
      accountId,
      protocolDocument,
      undefined,
      undefined,
      undefined,
      true,
      true,
      true,
    )
    const observedAt = native.observation.payload.observedAt
    const observation = (yield* makeJevObservation({
      ...native.input,
      equityShortEligibility: { AAPL: shortEligibilityFixture(accountId, 'AAPL', observedAt) },
    })).payload
    const at = new Date(Date.parse(observedAt) + 100).toISOString()
    const batchPlan = yield* makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observedAt) + native.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V8,
    })
    const initial = nativeJevBatchResult(batchPlan, at, (symbol) => symbol === 'AAPL')
    const candidates = []
    for (const candidate of initial.candidates) {
      if (
        candidate.symbol !== 'AAPL' ||
        candidate.status !== 'RESOLVED' ||
        candidate.receipt?.outcome.status !== JevOutcome.Completed
      ) {
        candidates.push(candidate)
        continue
      }
      const request = batchPlan.candidates.find((row) => row.symbol === candidate.symbol)
      if (request?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing short source request')
      const completion = entryCompletionFixture(request.request, at)
      const disposition = completion.handoff.disposition
      if (disposition.status !== 'READY' || completion.jev.status !== 'RECEIVED')
        throw new Error('Missing short proposals')
      const prepared = yield* prepareJevRequest(disposition.jevRequest)
      const response = yield* decodeJevResponse(prepared.request, {
        model: prepared.request.model,
        answers: Object.fromEntries(
          Object.keys(prepared.request.questions).map((name) => [
            name,
            {
              type: 'noul',
              noul:
                (name.includes('resistance_rejection') || name.includes('base_breakdown')) &&
                !name.endsWith('_target_obstructed')
                  ? 0.9
                  : 0.1,
            },
          ]),
        ),
        usage: { input_tokens: 200, output_tokens: 0 },
      })
      const receipt = yield* makeJevEvaluationReceipt(request.request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.request.requestId,
        startedAt: at,
        completedAt: at,
        outcome: {
          status: JevOutcome.Completed,
          completion: {
            ...completion,
            jev: {
              status: 'RECEIVED',
              inference: {
                ...completion.jev.inference,
                response,
                responseHash: yield* canonicalHashV1Result(response),
              },
            },
          },
        },
      })
      const resolution = { ...candidate.resolution, receiptHash: receipt.receiptHash }
      const { resolutionHash: _old, ...material } = resolution
      candidates.push({
        ...candidate,
        receipt,
        resolution: { ...material, resolutionHash: yield* canonicalHashV1Result(material) },
      })
    }
    const batchResult = yield* makeJevBatchResult(batchPlan, {
      schemaVersion: 'bayn.jev-batch-result.v1',
      batchId: batchPlan.batchId,
      completedAt: at,
      candidates,
    })
    const evidence = { observation, batchPlan, batchResult, decidedAt: at }
    const decision = yield* decideJevEntry(evidence)
    return { ...native, observation, batchPlan, batchResult, evidence, decision }
  })
