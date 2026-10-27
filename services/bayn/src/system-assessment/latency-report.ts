import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import {
  BacktestInputSchema,
  BacktestBuildEvidenceSchema,
  BacktestIssue,
  assessBacktestSession,
  backtestBrokerEvidenceConfig,
  backtestComparisonInput,
  prepareBacktest,
} from '../intraday-replay/backtest'
import { ReplayBrokerCheckpointSchema } from '../intraday-replay/broker-checkpoint'
import { replayDecisionReleaseAt } from '../intraday-replay/decision-latency'
import { ReplayInferenceCallSchema } from '../intraday-replay/inference-timing'
import { calculateReplayInferenceCosts, ReplayInferenceCostSummarySchema } from '../intraday-replay/inference-costs'
import { ReconciliationStatus } from '../execution/contracts'
import { validateRetainedReplayCalls } from '../intraday-replay/recorded-inference'
import { validateBacktestSourceReceipt } from '../intraday-replay/source'
import { decodeJevBatchPlan, decodeJevBatchResult, JevBatchPlanSchema, JevBatchResultSchema } from '../jev/batch'
import { reproduceJevCandidateObservation } from '../jev/observation'
import { JevObservationSchema } from '../jev/observation-contract'
import { JevPurpose } from '../jev/portfolio'
import { JevResearchPolicy } from '../jev/acceptance'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { SystemAssessmentError } from './economics'
import { ReplaySessionCostsSchema, reproduceReplaySessionEconomics } from './latency-economics'
import { LatencyStressSourcesSchema } from './latency-protocol'
import type { SystemRegistration } from './policy'
import type { SystemSourceCut } from './source-cut'
import { VerifiedReplayImage } from './replay-image'
import type { ReplayExecutionReceiptSchema } from './replay-execution'

// The complete report is hashed first; this projection decodes only fields used by this verifier.
const LatencyReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.backtest-report.v9'),
  reportHash: Sha256Schema,
  runId: Sha256Schema,
  executableSha256: Sha256Schema,
  evidenceMode: Schema.Literal('simulated-production-execution'),
  completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
  issues: Schema.Array(Schema.Enum(BacktestIssue)),
  sessionDates: Schema.Array(IsoDateSchema),
  sessions: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
      issues: Schema.Array(Schema.Enum(BacktestIssue)),
      schedule: Schema.Struct({
        firstPollAtMs: NonNegativeIntegerSchema,
        lastPollAtMs: NonNegativeIntegerSchema,
        completedAtMs: NonNegativeIntegerSchema,
        passCount: NonNegativeIntegerSchema,
        failedPassCount: NonNegativeIntegerSchema,
        unavailableDecisionPassCount: NonNegativeIntegerSchema,
      }),
      valuationFailureCount: NonNegativeIntegerSchema,
      closingEquity: Schema.Struct({
        equityMicros: SignedMicrosSchema,
        valuationQualified: Schema.Boolean,
        openOrderCount: NonNegativeIntegerSchema,
      }),
      reconciliation: Schema.Struct({
        report: Schema.Struct({
          reconciliation: Schema.Struct({ status: Schema.Enum(ReconciliationStatus) }),
          metrics: Schema.Struct({
            accountingExact: Schema.Boolean,
            discrepancyCount: NonNegativeIntegerSchema,
            cashDifferenceMicros: SignedMicrosSchema,
            positionDifferenceMicros: SignedMicrosSchema,
            equityDifferenceMicros: SignedMicrosSchema,
            brokerPollAgeMs: NonNegativeIntegerSchema,
            oldestUnknownMutationAgeMs: NonNegativeIntegerSchema,
          }),
        }),
        brokerState: Schema.Struct({ unknownOrderCount: NonNegativeIntegerSchema }),
        riskContext: Schema.Struct({ unknownMutationCount: NonNegativeIntegerSchema }),
      }),
      remainingPositions: Schema.Array(Schema.Unknown),
      modelCosts: ReplayInferenceCostSummarySchema,
      allocatedDataCostMicros: Schema.NullOr(UnsignedMicrosSchema),
    }),
  ),
  comparisonInput: Schema.Unknown,
  comparisonInputHash: Sha256Schema,
  sourceReceiptHash: Sha256Schema,
  build: BacktestBuildEvidenceSchema,
  brokerState: Schema.Unknown,
  brokerCheckpoint: ReplayBrokerCheckpointSchema,
  inference: Schema.Struct({
    definition: BacktestInputSchema.fields.inference,
    calls: Schema.Array(ReplayInferenceCallSchema),
    providerDispatchCount: NonNegativeIntegerSchema,
    retainedCallCount: NonNegativeIntegerSchema,
  }),
  momentumObservations: Schema.Array(Schema.Struct({ contentHash: Sha256Schema, payload: JevObservationSchema })),
  batches: Schema.Array(Schema.Struct({ plan: JevBatchPlanSchema, result: Schema.NullOr(JevBatchResultSchema) })),
  latencyStress: Schema.Struct({
    protocol: Schema.Unknown,
    protocolHash: Sha256Schema,
    calibration: Schema.Unknown,
    admittedObservationCount: NonNegativeIntegerSchema,
    unreleasedObservationHashes: Schema.Array(Sha256Schema),
    observationReceipts: Schema.Array(
      Schema.Struct({
        observationHash: Sha256Schema,
        commandIssuedAt: UtcInstantSchema,
        observedAt: UtcInstantSchema,
        completedAt: UtcInstantSchema,
        releaseFloorAt: UtcInstantSchema,
        releasedAt: UtcInstantSchema,
      }),
    ),
    admittedBatchCount: NonNegativeIntegerSchema,
    unreleasedBatchIds: Schema.Array(Sha256Schema),
    receipts: Schema.Array(
      Schema.Struct({
        batchId: Sha256Schema,
        resultHash: Sha256Schema,
        commandIssuedAt: UtcInstantSchema,
        batchObservedAt: UtcInstantSchema,
        completedAt: UtcInstantSchema,
        releaseFloorAt: UtcInstantSchema,
        releasedAt: UtcInstantSchema,
      }),
    ),
  }),
})

export const bindLatencyStressSources = (
  descriptors: typeof LatencyStressSourcesSchema.Type,
  registration: SystemRegistration,
  cut: SystemSourceCut,
  artifacts: ReadonlyMap<string, Uint8Array>,
  verifiedSources: ReadonlySet<string>,
  images: ReadonlyMap<string, VerifiedReplayImage> = new Map(),
  executions: ReadonlyMap<string, typeof ReplayExecutionReceiptSchema.Type> = new Map(),
) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const source = (hash: string) =>
      Result.gen(function* () {
        const bytes = artifacts.get(hash)
        if (bytes === undefined || sha256(bytes) !== hash || !verifiedSources.has(hash))
          return yield* fail('Latency stress requires the original verified artifact bytes')
        return new TextDecoder().decode(bytes)
      })
    if (new Set(descriptors.map((d) => d.policy)).size !== descriptors.length)
      return yield* fail('Duplicate latency stress policy evidence')
    const receipts = []
    for (const descriptor of descriptors) {
      const input = yield* Schema.decodeUnknownResult(
        Schema.fromJsonString(BacktestInputSchema),
        strictParseOptions,
      )(yield* source(descriptor.inputFileHash))
      if (input.policy !== descriptor.policy) return yield* fail('Latency replay policy differs from its descriptor')
      const capture = yield* validateBacktestSourceReceipt(
        yield* source(descriptor.captureFileHash),
        descriptor.captureFileHash,
      )
      const prepared = yield* prepareBacktest(input, capture)
      const stress = prepared.latencyStress
      if (
        input.latencyStress === null ||
        stress === null ||
        input.inference.mode !== 'retained-responses' ||
        (yield* canonicalHashV1Result(input.latencyStress.registration)) !==
          (yield* canonicalHashV1Result(registration)) ||
        (yield* canonicalHashV1Result(input.latencyStress.sourceCut)) !== (yield* canonicalHashV1Result(cut))
      )
        return yield* fail('Latency replay uses a different registration or calibration cut')
      const raw = yield* Schema.decodeUnknownResult(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(yield* source(descriptor.reportFileHash))
      const { reportHash, ...material } = raw
      if (reportHash !== (yield* canonicalHashV1Result(material)))
        return yield* fail('Latency report hash differs from its complete contents')
      const report = yield* Schema.decodeUnknownResult(LatencyReportSchema)(raw)
      const image = images.get(descriptor.reportFileHash)?.receipt ?? null
      const execution =
        descriptor.executionReceiptHash === null ? null : (executions.get(descriptor.executionReceiptHash) ?? null)
      if (
        execution !== null &&
        ((yield* canonicalHashV1Result(execution)) !== descriptor.executionReceiptHash ||
          execution.inputFileHash !== descriptor.inputFileHash ||
          execution.captureFileHash !== descriptor.captureFileHash ||
          execution.reportFileHash !== descriptor.reportFileHash ||
          execution.reportHash !== report.reportHash ||
          execution.runId !== report.runId ||
          execution.arrivalsFileHash !== input.source.dataSha256 ||
          execution.registrationHash !== (yield* canonicalHashV1Result(registration)) ||
          execution.sourceCutHash !== (yield* canonicalHashV1Result(cut)) ||
          (yield* canonicalHashV1Result(execution.image)) !== (yield* canonicalHashV1Result(image)))
      )
        return yield* fail('Retained execution receipt differs from the replay evidence or registered image')
      const definition = registration.policies.find((p) => p.policy === descriptor.policy)
      if (
        image !== null &&
        (definition === undefined ||
          image.policyDefinitionHash !== (yield* canonicalHashV1Result(definition)) ||
          image.platform !== descriptor.imagePlatform ||
          image.repository !== input.build.imageRepository ||
          image.executableSha256 !== report.executableSha256)
      )
        return yield* fail('Verified image membership differs from this replay or registered policy')
      const costs = yield* Schema.decodeUnknownResult(
        Schema.fromJsonString(ReplaySessionCostsSchema),
        strictParseOptions,
      )(yield* source(descriptor.costsFileHash))
      const same = (left: unknown, right: unknown) =>
        Result.gen(function* () {
          return (yield* canonicalHashV1Result(left)) === (yield* canonicalHashV1Result(right))
        })
      const { sourceAndStrategyVerification: _localVerification, ...expectedBuild } = prepared.buildEvidence
      const { sourceAndStrategyVerification: reportedVerification, ...reportedBuild } = report.build
      if (
        report.runId !== prepared.runId ||
        report.sourceReceiptHash !== capture.contentHash ||
        report.comparisonInputHash !== (yield* canonicalHashV1Result(backtestComparisonInput(prepared.input))) ||
        !(yield* same(report.comparisonInput, backtestComparisonInput(prepared.input))) ||
        !(yield* same(reportedBuild, expectedBuild)) ||
        (execution !== null && reportedVerification !== 'embedded') ||
        !verifiedSources.has(input.source.dataSha256) ||
        !(yield* same(report.brokerState, report.brokerCheckpoint.state)) ||
        report.brokerCheckpoint.observedAt > cut.asOf ||
        costs.asOf > cut.asOf ||
        costs.policy !== descriptor.policy ||
        !(yield* same(costs.inferenceCalls, report.inference.calls)) ||
        !(yield* same(costs.inferenceTariff, input.inference.costs)) ||
        !(yield* same(report.inference.definition, input.inference)) ||
        report.inference.providerDispatchCount !== 0 ||
        report.inference.retainedCallCount !== report.inference.calls.length ||
        (input.policy === JevResearchPolicy.Ablation && report.inference.calls.some((call) => call.stage === 'JEV')) ||
        (input.policy === JevResearchPolicy.Momentum && report.inference.calls.length !== 0) ||
        report.latencyStress.protocolHash !== stress.protocolHash ||
        !(yield* same(report.latencyStress.protocol, stress.protocol)) ||
        !(yield* same(report.latencyStress.calibration, stress.calibration))
      )
        return yield* fail('Latency report differs from its registered replay, retained costs or calibration')

      const windows = registration.calendar.sessions
      if (
        report.sessions.length !== windows.length ||
        report.brokerCheckpoint.state.sessionCloses.length !== windows.length ||
        !(yield* same(
          report.sessionDates,
          windows.map((window) => window.sessionDate),
        ))
      )
        return yield* fail('Latency report omits or substitutes registered sessions')
      let allSessionsComplete = true
      for (const [index, window] of windows.entries()) {
        const session = report.sessions[index]
        const close = report.brokerCheckpoint.state.sessionCloses[index]
        if (
          session === undefined ||
          session.sessionDate !== window.sessionDate ||
          close?.sessionDate !== window.sessionDate
        )
          return yield* fail('Latency report reorders, duplicates or substitutes registered sessions')
        const { schedule, reconciliation } = session
        if (
          schedule.firstPollAtMs < Date.parse(window.openAt) ||
          schedule.lastPollAtMs !== Date.parse(window.closeAt) ||
          (schedule.passCount > 0 && schedule.firstPollAtMs > schedule.lastPollAtMs) ||
          schedule.completedAtMs < schedule.lastPollAtMs ||
          schedule.completedAtMs > Date.parse(report.brokerCheckpoint.observedAt) ||
          schedule.failedPassCount + schedule.unavailableDecisionPassCount > schedule.passCount ||
          session.closingEquity.equityMicros !== close.equityMicros ||
          session.closingEquity.valuationQualified !== close.valuationQualified ||
          session.allocatedDataCostMicros !== input.allocatedDataCostPerSessionMicros
        )
          return yield* fail('Latency session changed its scheduled window, execution counts, closing mark or costs')
        const calls = report.inference.calls.filter(
          (call) => window.openAt <= call.simulatedStartedAt && call.simulatedStartedAt <= window.closeAt,
        )
        const modelCosts = calculateReplayInferenceCosts(calls, input.inference.costs)
        if (!(yield* same(modelCosts, session.modelCosts)))
          return yield* fail('Latency session model costs do not reproduce its retained calls')
        const assessed = assessBacktestSession({
          finalWindow: true,
          failedPassCount: schedule.failedPassCount,
          unavailableDecisionPassCount: schedule.unavailableDecisionPassCount,
          valuationFailureCount: session.valuationFailureCount,
          reconciliation: {
            status: reconciliation.report.reconciliation.status,
            metrics: reconciliation.report.metrics,
            unknownOrderCount: reconciliation.brokerState.unknownOrderCount,
            unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
          },
          remainingPositionCount: session.remainingPositions.length,
          remainingOpenOrderCount: session.closingEquity.openOrderCount,
        })
        const issues = [
          ...assessed.issues,
          ...(modelCosts.unresolvedCallCount === 0 ? [] : [BacktestIssue.UnresolvedModelCost]),
          ...(session.allocatedDataCostMicros === null ? [BacktestIssue.UnresolvedDataCost] : []),
        ]
        const complete = issues.length === 0
        if (
          !(yield* same(session.issues, issues)) ||
          session.completion !== (complete ? 'COMPLETE' : 'INCOMPLETE') ||
          (complete && (!session.closingEquity.valuationQualified || schedule.passCount === 0))
        )
          return yield* fail('Latency session completion contradicts its retained execution evidence')
        allSessionsComplete &&= complete
      }
      if (report.completion === 'COMPLETE' && !allSessionsComplete)
        return yield* fail('Latency report hides an incomplete registered session')

      const batches = new Map(report.batches.map((batch) => [batch.plan.batchId, batch]))
      const batchProtocolHash = yield* canonicalHashV1Result(prepared.protocol)
      const releases = new Map(report.latencyStress.receipts.map((receipt) => [receipt.batchId, receipt]))
      const unreleased = new Set(report.latencyStress.unreleasedBatchIds)
      if (
        batches.size !== report.batches.length ||
        releases.size !== report.latencyStress.receipts.length ||
        unreleased.size !== report.latencyStress.unreleasedBatchIds.length ||
        batches.size !== report.latencyStress.admittedBatchCount ||
        releases.size + unreleased.size !== batches.size ||
        [...unreleased].some((id) => !batches.has(id) || releases.has(id)) ||
        [...releases.keys()].some((id) => !batches.has(id))
      )
        return yield* fail('Latency release inventory omits or duplicates an admitted batch')
      for (const { plan: rawPlan, result: rawResult } of report.batches) {
        const plan = yield* decodeJevBatchPlan(rawPlan)
        if (plan.schemaVersion !== prepared.policyIdentity.planVersion)
          return yield* fail('Latency batch differs from the registered replay policy')
        if (plan.protocolHash !== batchProtocolHash) return yield* fail('Latency batch changed the registered protocol')
        const result = rawResult === null ? null : yield* decodeJevBatchResult(plan, rawResult)
        const release = releases.get(plan.batchId)
        if (release === undefined) continue
        const issued = Date.parse(release.commandIssuedAt)
        const completed = Date.parse(release.completedAt)
        const required = replayDecisionReleaseAt(issued, completed, stress.p95FullBatchMs)
        if (
          result === null ||
          release.resultHash !== result.resultHash ||
          release.batchObservedAt !== plan.observedAt ||
          release.commandIssuedAt > plan.observedAt ||
          result.completedAt > release.completedAt ||
          required === undefined ||
          Date.parse(release.releaseFloorAt) !== issued + stress.p95FullBatchMs ||
          Date.parse(release.releasedAt) < required ||
          release.releasedAt > report.brokerCheckpoint.observedAt ||
          !registration.calendar.sessions.some(
            (session) => session.openAt <= release.commandIssuedAt && release.commandIssuedAt <= session.closeAt,
          )
        )
          return yield* fail('Latency release does not reproduce its original command, result and registered floor')
      }
      const observations = new Map(report.momentumObservations.map((o) => [o.contentHash, o.payload]))
      const observationReleases = new Map(report.latencyStress.observationReceipts.map((r) => [r.observationHash, r]))
      const unreleasedObservations = new Set(report.latencyStress.unreleasedObservationHashes)
      if (
        observations.size !== report.momentumObservations.length ||
        observationReleases.size !== report.latencyStress.observationReceipts.length ||
        unreleasedObservations.size !== report.latencyStress.unreleasedObservationHashes.length ||
        observations.size !== report.latencyStress.admittedObservationCount ||
        observationReleases.size + unreleasedObservations.size !== observations.size ||
        [...unreleasedObservations].some((id) => !observations.has(id) || observationReleases.has(id)) ||
        [...observationReleases.keys()].some((id) => !observations.has(id)) ||
        (input.policy !== JevResearchPolicy.Momentum && observations.size !== 0) ||
        (input.policy === JevResearchPolicy.Momentum && batches.size !== 0)
      )
        return yield* fail('Latency observation inventory omits, substitutes or duplicates a native source')
      if (
        unreleased.size > 0 !== report.issues.includes(BacktestIssue.UnreleasedLatencyBatch) ||
        unreleasedObservations.size > 0 !== report.issues.includes(BacktestIssue.UnreleasedLatencyObservation) ||
        (report.completion === 'COMPLETE' && (unreleased.size > 0 || unreleasedObservations.size > 0))
      )
        return yield* fail('Latency report completion hides or invents an unreleased admission')
      for (const [hash, payload] of observations) {
        const source = yield* reproduceJevCandidateObservation(payload)
        if (
          source.contentHash !== hash ||
          source.portfolio.purpose !== JevPurpose.Entry ||
          source.portfolio.brokerState.account.accountId !== `replay-${prepared.runId}` ||
          (yield* canonicalHashV1Result(source.protocol)) !== batchProtocolHash
        )
          return yield* fail('Latency observation differs from the registered native replay source')
        const release = observationReleases.get(hash)
        if (release === undefined) continue
        const issued = Date.parse(release.commandIssuedAt)
        const required = replayDecisionReleaseAt(issued, Date.parse(release.completedAt), stress.p95FullBatchMs)
        if (
          release.observedAt !== source.observedAt ||
          release.commandIssuedAt > release.observedAt ||
          release.observedAt > release.completedAt ||
          required === undefined ||
          Date.parse(release.releaseFloorAt) !== issued + stress.p95FullBatchMs ||
          Date.parse(release.releasedAt) < required ||
          release.releasedAt > report.brokerCheckpoint.observedAt ||
          !registration.calendar.sessions.some(
            (s) => s.openAt <= release.commandIssuedAt && release.commandIssuedAt <= s.closeAt,
          )
        )
          return yield* fail(
            'Latency observation release changed its original command, durable completion or registered floor',
          )
      }
      if (report.completion === 'COMPLETE') {
        yield* validateRetainedReplayCalls(input.inference.recording, report.inference.calls)
        const available = new Map<string, (typeof report.inference.calls)[number][]>()
        for (const call of report.inference.calls) {
          const key = `${call.stage}:${call.requestHash}`
          const entries = available.get(key) ?? []
          entries.push(call)
          available.set(key, entries)
        }
        const consume = (
          stage: string,
          requestHash: string,
          responseHash: string | null,
          status: 'RECEIVED' | 'FAILED',
          start: string,
          end: string,
        ) => {
          const entries = available.get(`${stage}:${requestHash}`)
          const index =
            entries?.findIndex((call) => {
              const outcome = call.outcome
              return (
                call.simulatedStartedAt >= start &&
                call.simulatedStartedAt <= end &&
                outcome.status === status &&
                (outcome.status === 'RECEIVED'
                  ? outcome.inference.responseHash === responseHash
                  : outcome.status === 'FAILED' && outcome.responseHash === responseHash)
              )
            }) ?? -1
          if (entries === undefined || index < 0) return false
          entries.splice(index, 1)
          return true
        }
        for (const batch of report.batches)
          for (const candidate of batch.result?.candidates ?? []) {
            if (candidate.status !== 'RESOLVED') continue
            const receipt = candidate.receipt
            if (receipt?.outcome.status !== 'COMPLETED') continue
            const completion = receipt.outcome.completion
            const { disposition, visualRequestHash } = completion.handoff
            if (disposition.status !== 'SOURCE_INFEASIBLE') {
              const received = disposition.status !== 'VISUAL_FAILED'
              const responseHash =
                disposition.status === 'VISUAL_FAILED'
                  ? disposition.failure.responseHash
                  : disposition.visual.responseHash
              if (
                !consume(
                  'CHART',
                  visualRequestHash,
                  responseHash,
                  received ? 'RECEIVED' : 'FAILED',
                  receipt.startedAt,
                  receipt.completedAt,
                )
              )
                return yield* fail('Latency report omitted or substituted a charged chart inference')
            }
            if (completion.jev.status === 'RECEIVED' || completion.jev.status === 'FAILED') {
              if (
                disposition.status !== 'READY' ||
                !consume(
                  'JEV',
                  disposition.jevRequestHash,
                  completion.jev.status === 'RECEIVED'
                    ? completion.jev.inference.responseHash
                    : completion.jev.responseHash,
                  completion.jev.status,
                  receipt.startedAt,
                  receipt.completedAt,
                )
              )
                return yield* fail('Latency report omitted or substituted a charged Jev inference')
            }
          }
      }
      const reproducedEconomics =
        report.completion === 'COMPLETE' &&
        report.issues.length === 0 &&
        unreleased.size === 0 &&
        unreleasedObservations.size === 0
          ? yield* reproduceReplaySessionEconomics(
              registration,
              yield* backtestBrokerEvidenceConfig(prepared),
              report.brokerCheckpoint,
              costs,
              verifiedSources,
            )
          : null
      const receipt = {
        policy: descriptor.policy,
        protocolHash: stress.protocolHash,
        reportFileHash: descriptor.reportFileHash,
        reportHash: report.reportHash,
        costsFileHash: descriptor.costsFileHash,
        registrationHash: yield* canonicalHashV1Result(registration),
        sourceCutHash: yield* canonicalHashV1Result(cut),
        image,
        executionReceiptHash: execution === null ? null : descriptor.executionReceiptHash,
        economics: image === null || execution === null ? null : reproducedEconomics,
      }
      receipts.push({ ...receipt, sourceHash: yield* canonicalHashV1Result(receipt) })
    }
    return receipts
  }).pipe(
    Result.mapError(
      (cause) => new SystemAssessmentError({ message: 'Latency stress evidence could not be reproduced', cause }),
    ),
  )

export type VerifiedLatencyStress = Result.Result.Success<ReturnType<typeof bindLatencyStressSources>>[number]

export const verifyLatencyStressImages = (
  descriptors: typeof LatencyStressSourcesSchema.Type,
  registration: SystemRegistration,
  artifacts: ReadonlyMap<string, Uint8Array>,
) =>
  Effect.gen(function* () {
    const images = new Map<string, VerifiedReplayImage>()
    const read = <S extends Schema.Top>(hash: string, schema: S) =>
      Effect.gen(function* () {
        const bytes = artifacts.get(hash)
        if (bytes === undefined || sha256(bytes) !== hash)
          return yield* new SystemAssessmentError({
            message: 'Replay image verification requires retained artifact bytes',
          })
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes))
      })
    for (const descriptor of descriptors) {
      if (descriptor.imagePlatform === null) continue
      const definition = registration.policies.find((p) => p.policy === descriptor.policy)
      if (definition === undefined)
        return yield* new SystemAssessmentError({ message: 'Replay image policy is unregistered' })
      const input = yield* read(descriptor.inputFileHash, BacktestInputSchema)
      if (input.policy !== descriptor.policy)
        return yield* new SystemAssessmentError({ message: 'Replay image descriptor differs from its selected policy' })
      const report = yield* read(descriptor.reportFileHash, LatencyReportSchema)
      const image = yield* VerifiedReplayImage.inspect(
        definition,
        input.build.imageRepository,
        descriptor.imagePlatform,
        report.executableSha256,
      )
      images.set(descriptor.reportFileHash, image)
    }
    return images
  })
