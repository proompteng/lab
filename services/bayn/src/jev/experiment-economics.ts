import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { BacktestComparisonInputSchema, BacktestInputSchema, BacktestIssue } from '../intraday-replay/backtest'
import { ReplayBrokerCheckpointSchema } from '../intraday-replay/broker-checkpoint'
import { calculateReplayJevCosts, ReplayJevCostSummarySchema } from '../intraday-replay/jev-costs'
import { ReplayJevCallSchema } from '../intraday-replay/jev-timing'
import { applyReplayFill, createReplayLedger } from '../intraday-replay/ledger'
import { SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
import {
  GitSourceRevisionSchema,
  ImageDigestSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { JevContractError, JevFailure, decodeJevResponse, prepareJevRequest } from './contract'
import { applyJevInstructions } from './instruction-evaluation'
import { jevInstructions } from './instructions'
import { JevInstructionsSchema, type JevInstructions } from './instructions-contract'
import { JevInstructionVariantBuildSchema } from './instruction-variant'
import { defaultJevProtocolDocument, jevBehaviorHash } from './protocol'

// Decode only the consumed projection after verifying the complete original document hash.
const NativeEconomicReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.backtest-report.v4'),
  comparisonInput: BacktestComparisonInputSchema,
  comparisonInputHash: Sha256Schema,
  jevInstructions: Schema.Struct({ contentHash: Sha256Schema, document: JevInstructionsSchema }),
  evidenceMode: Schema.Literal('simulated-production-execution'),
  runId: Sha256Schema,
  executableSha256: Sha256Schema,
  reportHash: Sha256Schema,
  inference: Schema.Struct({
    definition: BacktestInputSchema.fields.inference,
    calls: Schema.Array(ReplayJevCallSchema),
    providerDispatchCount: NonNegativeIntegerSchema,
    costs: ReplayJevCostSummarySchema,
  }),
  completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
  issues: Schema.Array(Schema.Enum(BacktestIssue)),
  source: SimulatedSnapshotSourceSchema,
  sourceReceiptHash: Sha256Schema,
  build: Schema.Struct({
    sourceRevision: GitSourceRevisionSchema,
    imageRepository: StrictNonEmptyStringSchema,
    declaredImageDigest: ImageDigestSchema,
    imageDigestVerification: Schema.Literal('unverified-input'),
    strategyBehaviorHash: Sha256Schema,
    strategyParameterHash: Sha256Schema,
    sourceAndStrategyVerification: Schema.Literals(['configured', 'embedded']),
  }),
  assumptions: BacktestInputSchema.fields.assumptions,
  sessionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  maximumObservedDrawdownMicros: Schema.NullOr(UnsignedMicrosSchema),
  reconciledExecutionPnlAfterCostsMicros: Schema.NullOr(SignedMicrosSchema),
  reconciledNetPnlAfterCostsMicros: Schema.NullOr(SignedMicrosSchema),
  dataCostMicros: Schema.NullOr(UnsignedMicrosSchema),
  brokerState: Schema.Struct({ ledger: ReplayBrokerCheckpointSchema.fields.state.fields.ledger }),
  sessions: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
      issues: Schema.Array(Schema.Enum(BacktestIssue)),
      closingNetEquityMicros: SignedMicrosSchema,
      modelCosts: ReplayJevCostSummarySchema,
      allocatedDataCostMicros: Schema.NullOr(UnsignedMicrosSchema),
      netEquityChangeMicros: Schema.NullOr(SignedMicrosSchema),
    }),
  ),
})

const CostAllocationSchema = Schema.NullOr(
  Schema.Struct({ costMicros: UnsignedMicrosSchema, evidenceHash: Sha256Schema }),
)
export const JevEconomicRegistrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-economic-registration.v2'),
  studyId: Sha256Schema,
  evaluatorSourceRevision: GitSourceRevisionSchema,
  compilerDependencyReceiptSha256: Sha256Schema,
  registeredAt: UtcInstantSchema,
  baseline: JevInstructionsSchema,
  candidate: JevInstructionsSchema,
  sessionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1), Schema.isMaxLength(366), Schema.isUnique()),
  maximumDrawdownMicros: PositiveMicrosSchema,
})
export type JevEconomicRegistration = typeof JevEconomicRegistrationSchema.Type
export const JevOperatingAllocationsSchema = Schema.Array(
  Schema.Struct({
    sessionDate: IsoDateSchema,
    infrastructure: CostAllocationSchema,
    research: CostAllocationSchema,
  }),
)
const NativeReportArtifactSchema = Schema.Struct({
  reportPath: StrictNonEmptyStringSchema,
  reportSha256: Sha256Schema,
  operatingAllocations: JevOperatingAllocationsSchema,
})
export const JevEconomicComparisonManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-economic-manifest.v2'),
  registration: JevEconomicRegistrationSchema,
  baseline: NativeReportArtifactSchema,
  baselineRepeat: NativeReportArtifactSchema,
  candidate: Schema.Struct({
    ...NativeReportArtifactSchema.fields,
    buildReceipt: Schema.Struct({ path: StrictNonEmptyStringSchema, sha256: Sha256Schema }),
  }),
})

const invalid = (message: string) => Result.fail(new JevContractError({ message }))
const hash = canonicalHashV1Result

/** The caller supplies the actual native replay result, including its complete paid-call and fill inventory. */
export const jevBacktestOutcome = (input: {
  readonly report: unknown
  readonly instructions: JevInstructions
  readonly operatingAllocations: unknown
  readonly variantBuild: unknown
}) =>
  Result.gen(function* () {
    const instructions = input.instructions
    const raw = yield* Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(input.report)
    const { reportHash, ...material } = raw
    if (reportHash !== (yield* hash(material))) return yield* invalid('Native replay report hash differs')
    const report = yield* Schema.decodeUnknownResult(NativeEconomicReportSchema)(raw)
    const variantBuild =
      input.variantBuild === null
        ? null
        : yield* Schema.decodeUnknownResult(JevInstructionVariantBuildSchema, strictParseOptions)(input.variantBuild)
    if (variantBuild === null && (yield* hash(instructions)) !== (yield* hash(jevInstructions)))
      return yield* invalid('Candidate native reports require their compiler build receipt')
    if (variantBuild !== null) {
      const { receiptHash, ...material } = variantBuild
      if (
        variantBuild.spec.evaluation !== 'portfolio' ||
        receiptHash !== (yield* hash(material)) ||
        variantBuild.executableSha256 !== report.executableSha256 ||
        variantBuild.spec.sourceRevision !== report.build.sourceRevision ||
        variantBuild.spec.imageRepository !== report.build.imageRepository ||
        variantBuild.spec.baseImageDigest !== report.build.declaredImageDigest ||
        variantBuild.strategyBehaviorHash !== report.build.strategyBehaviorHash ||
        variantBuild.strategyParameterHash !== report.build.strategyParameterHash ||
        variantBuild.baselineInstructionsHash !== (yield* hash(jevInstructions)) ||
        variantBuild.instructionsHash !== (yield* hash(instructions)) ||
        (yield* hash(variantBuild.spec.instructions)) !== variantBuild.instructionsHash
      )
        return yield* invalid(
          'Candidate compiler receipt differs from native executable, instructions or build context',
        )
    }
    if (report.comparisonInputHash !== (yield* hash(report.comparisonInput)))
      return yield* invalid('Native normalized replay inputs do not reproduce their comparison identity')
    const registeredDataCost = report.comparisonInput.allocatedDataCostPerSessionMicros
    if (
      report.sessions.some((session) => session.allocatedDataCostMicros !== registeredDataCost) ||
      report.dataCostMicros !==
        (registeredDataCost === null ? null : String(BigInt(registeredDataCost) * BigInt(report.sessions.length)))
    )
      return yield* invalid('Native data costs differ from the frozen allocation or its unknown coverage')
    if (
      report.jevInstructions.contentHash !== (yield* hash(instructions)) ||
      report.jevInstructions.contentHash !== (yield* hash(report.jevInstructions.document))
    )
      return yield* invalid('Native report does not bind the registered compiled Jev instructions')
    if (
      report.build.strategyBehaviorHash !== jevBehaviorHash ||
      report.build.strategyParameterHash !== (yield* hash(defaultJevProtocolDocument))
    )
      return yield* invalid('Native report strategy differs from the compiled execution and cost model')
    if (report.source.runId !== report.runId) return yield* invalid('Native source belongs to another replay run')
    const costs = calculateReplayJevCosts(report.inference.calls, report.inference.definition.costs)
    const undispatched = report.inference.calls.filter(
      (call) => call.outcome.status === 'FAILED' && call.outcome.failure === JevFailure.NotDispatched,
    ).length
    const ambiguousDispatches = report.inference.calls.filter(
      (call) => call.outcome.status === 'INTERRUPTED' || call.outcome.status === 'DEFECT',
    ).length
    const maximumDispatches = report.inference.calls.length - undispatched
    if (
      report.inference.providerDispatchCount > report.inference.definition.maximumCalls ||
      report.inference.providerDispatchCount > maximumDispatches ||
      report.inference.providerDispatchCount < maximumDispatches - ambiguousDispatches
    )
      return yield* invalid('Native provider dispatch inventory differs from retained outcomes or its frozen budget')
    if ((yield* hash(costs)) !== (yield* hash(report.inference.costs)))
      return yield* invalid('Native replay inference expense does not reproduce')
    for (const call of report.inference.calls) {
      const request = yield* prepareJevRequest(call.request)
      const edited = yield* applyJevInstructions(request.request, instructions)
      if (
        request.requestHash !== call.requestHash ||
        edited.requestHash !== request.requestHash ||
        call.providerCompletedAt < call.providerStartedAt
      )
        return yield* invalid('Replay used different Jev instructions or request bytes')
      if (call.outcome.status === 'RECEIVED') {
        const inference = call.outcome.inference
        yield* decodeJevResponse(request.request, inference.response)
        if (
          inference.requestHash !== request.requestHash ||
          inference.responseHash !== (yield* hash(inference.response)) ||
          inference.startedAt < call.providerStartedAt ||
          inference.completedAt < inference.startedAt ||
          inference.completedAt > call.providerCompletedAt
        )
          return yield* invalid('Replay inference does not bind its measured provider call')
      }
    }
    let ledger = yield* createReplayLedger(report.brokerState.ledger.openingCashMicros)
    for (const fill of report.brokerState.ledger.fills)
      ledger = yield* applyReplayFill(
        ledger,
        fill,
        fill.quantityAtoms,
        defaultJevProtocolDocument.executionModel,
        report.assumptions.feeMultiplierPpm,
      )
    if (
      ledger.cashMicros !== report.brokerState.ledger.cashMicros ||
      ledger.executionFeesMicros !== report.brokerState.ledger.executionFeesMicros ||
      ledger.netRealizedPnlAfterCostsMicros !== report.brokerState.ledger.netRealizedPnlAfterCostsMicros ||
      ledger.netRealizedPnlAfterCostsMicros !== report.reconciledExecutionPnlAfterCostsMicros ||
      (yield* hash(ledger.positions)) !== (yield* hash(report.brokerState.ledger.positions))
    )
      return yield* invalid('Native replay cash, inventory or execution fees do not reproduce')
    if (
      report.completion === 'COMPLETE' &&
      (ledger.positions.length !== 0 ||
        report.reconciledNetPnlAfterCostsMicros === null ||
        report.maximumObservedDrawdownMicros === null ||
        report.dataCostMicros === null)
    )
      return yield* invalid('Complete native replay requires closed inventory, net costs and drawdown')
    const allocations = yield* Schema.decodeUnknownResult(
      JevOperatingAllocationsSchema,
      strictParseOptions,
    )(input.operatingAllocations)
    const dates = report.sessions.map((session) => session.sessionDate)
    if (
      (yield* hash(dates)) !== (yield* hash(report.sessionDates)) ||
      (yield* hash(dates)) !== (yield* hash(allocations.map((allocation) => allocation.sessionDate)))
    )
      return yield* invalid('Operating allocations must cover every native session exactly once and in order')
    const rows = []
    let operatingCost = 0n
    let operatingComplete = true
    let previous = BigInt(ledger.openingCashMicros)
    let totalNet = 0n
    let totalData = 0n
    let totalModel = 0n
    let callIndex = 0
    for (const [index, session] of report.sessions.entries()) {
      const allocation = allocations[index]
      if (allocation === undefined) return yield* invalid('Missing operating allocation')
      const sessionCalls = report.inference.calls.slice(callIndex, callIndex + session.modelCosts.callCount)
      callIndex += session.modelCosts.callCount
      if (
        (yield* hash(calculateReplayJevCosts(sessionCalls, report.inference.definition.costs))) !==
        (yield* hash(session.modelCosts))
      )
        return yield* invalid('Native session inference inventory or expense does not reproduce')
      if (allocation.infrastructure === null || allocation.research === null) operatingComplete = false
      if (allocation.infrastructure !== null) operatingCost += BigInt(allocation.infrastructure.costMicros)
      if (allocation.research !== null) operatingCost += BigInt(allocation.research.costMicros)
      const delta = BigInt(session.closingNetEquityMicros) - previous
      if (session.netEquityChangeMicros !== null && BigInt(session.netEquityChangeMicros) !== delta)
        return yield* invalid('Native session equity carry differs from its net outcome')
      previous = BigInt(session.closingNetEquityMicros)
      totalNet += delta
      if (session.allocatedDataCostMicros !== null) totalData += BigInt(session.allocatedDataCostMicros)
      totalModel += BigInt(session.modelCosts.knownCostMicros)
      const complete =
        report.completion === 'COMPLETE' &&
        report.issues.length === 0 &&
        session.completion === 'COMPLETE' &&
        session.issues.length === 0 &&
        session.netEquityChangeMicros !== null &&
        session.allocatedDataCostMicros !== null &&
        costs.unresolvedCallCount === 0 &&
        allocation.infrastructure !== null &&
        allocation.research !== null
      rows.push({
        sessionDate: session.sessionDate,
        complete,
        netMicros: complete
          ? String(delta - BigInt(allocation.infrastructure.costMicros) - BigInt(allocation.research.costMicros))
          : null,
        knownNativeNetMicros: String(delta),
        infrastructure: allocation.infrastructure,
        research: allocation.research,
      })
    }
    if (
      callIndex !== report.inference.calls.length ||
      (report.dataCostMicros !== null && totalData !== BigInt(report.dataCostMicros)) ||
      totalModel !== BigInt(costs.knownCostMicros) ||
      (report.reconciledNetPnlAfterCostsMicros !== null &&
        (ledger.netRealizedPnlAfterCostsMicros === null ||
          BigInt(report.reconciledNetPnlAfterCostsMicros) !==
            BigInt(ledger.netRealizedPnlAfterCostsMicros) - totalData - totalModel ||
          totalNet !== BigInt(report.reconciledNetPnlAfterCostsMicros)))
    )
      return yield* invalid('Native net result differs from cash, metered inference and data costs')
    const { runId: _sourceRunId, ...sourceContext } = report.source
    return {
      reportHash: report.reportHash,
      runId: report.runId,
      executableSha256: report.executableSha256,
      variantBuildReceiptHash: variantBuild?.receiptHash ?? null,
      compilerDependencyReceiptSha256: variantBuild?.spec.dependencyReceiptSha256 ?? null,
      instructionsHash: yield* hash(instructions),
      contextHash: yield* hash({
        comparisonInputHash: report.comparisonInputHash,
        source: sourceContext,
        sourceReceiptHash: report.sourceReceiptHash,
        assumptions: report.assumptions,
        inferenceDefinition: report.inference.definition,
        sessionDataCosts: report.sessions.map((session) => ({
          sessionDate: session.sessionDate,
          costMicros: session.allocatedDataCostMicros,
        })),
        sourceRevision: report.build.sourceRevision,
        imageDigest: report.build.declaredImageDigest,
        openingCashMicros: ledger.openingCashMicros,
        strategyBehaviorHash: report.build.strategyBehaviorHash,
        strategyParameterHash: report.build.strategyParameterHash,
        sessionDates: report.sessionDates,
      }),
      providerRequests: report.inference.providerDispatchCount,
      executionPnlMicros: ledger.netRealizedPnlAfterCostsMicros,
      knownModelCostMicros: costs.knownCostMicros,
      unresolvedModelCalls: costs.unresolvedCallCount,
      dataCostMicros: report.dataCostMicros,
      remainingPositions: ledger.positions.length,
      issues: [...new Set([...report.issues, ...report.sessions.flatMap((session) => session.issues)])],
      knownNetPnlMicros:
        ledger.netRealizedPnlAfterCostsMicros === null || ledger.positions.length !== 0
          ? null
          : String(
              BigInt(ledger.netRealizedPnlAfterCostsMicros) -
                BigInt(costs.knownCostMicros) -
                BigInt(report.dataCostMicros ?? '0') -
                operatingCost,
            ),
      costCoverage:
        operatingComplete && report.dataCostMicros !== null && costs.unresolvedCallCount === 0
          ? ('COMPLETE' as const)
          : ('KNOWN_COSTS_ONLY' as const),
      conservativeMaximumDrawdownMicros:
        report.maximumObservedDrawdownMicros === null || !operatingComplete
          ? null
          : String(BigInt(report.maximumObservedDrawdownMicros) + operatingCost),
      rows,
    }
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev native economic evidence failed', cause })))

export type JevBacktestOutcome = Result.Result.Success<ReturnType<typeof jevBacktestOutcome>>

export enum JevObservedNetEffect {
  Higher = 'HIGHER_NATIVE_REPLAY_NET',
  Lower = 'LOWER_NATIVE_REPLAY_NET',
  Unchanged = 'NO_MEASURED_NET_CHANGE',
  Inconclusive = 'INCONCLUSIVE',
}

export const compareJevEconomics = (
  input: unknown,
  arms: {
    readonly baseline: JevBacktestOutcome
    readonly baselineRepeat: JevBacktestOutcome
    readonly candidate: JevBacktestOutcome
  },
) =>
  Result.gen(function* () {
    const registration = yield* Schema.decodeUnknownResult(JevEconomicRegistrationSchema, strictParseOptions)(input)
    if ((yield* hash(registration.baseline)) !== (yield* hash(jevInstructions)))
      return yield* invalid('Economic baseline differs from the compiled live Jev instructions')
    const { baseline, baselineRepeat, candidate } = arms
    if (baselineRepeat.executableSha256 !== baseline.executableSha256)
      return yield* invalid('Unchanged-prompt repeat must use the exact baseline executable')
    if (
      candidate.instructionsHash === baseline.instructionsHash ||
      candidate.executableSha256 === baseline.executableSha256 ||
      candidate.variantBuildReceiptHash === null
    )
      return yield* invalid('Candidate requires changed instructions and a distinct compiled executable')
    if (candidate.compilerDependencyReceiptSha256 !== registration.compilerDependencyReceiptSha256)
      return yield* invalid('Candidate compiler dependencies differ from the registered pinned image receipt')
    const expectedDates = registration.sessionDates
    if (expectedDates.join() !== [...expectedDates].sort().join())
      return yield* invalid('Economic sessions must be registered in chronological order')
    for (const arm of [baseline, baselineRepeat, candidate]) {
      if (
        arm.contextHash !== baseline.contextHash ||
        (yield* hash(arm.rows.map((row) => row.sessionDate))) !== (yield* hash(expectedDates))
      )
        return yield* invalid('Native arms differ in source, capital, strategy, execution assumptions or sessions')
    }
    if (
      baseline.instructionsHash !== (yield* hash(registration.baseline)) ||
      baselineRepeat.instructionsHash !== baseline.instructionsHash ||
      candidate.instructionsHash !== (yield* hash(registration.candidate)) ||
      new Set([baseline.runId, baselineRepeat.runId, candidate.runId]).size !== 3
    )
      return yield* invalid('Economic arms require distinct native runs and the registered instruction identities')
    const reasons = []
    if (Date.parse(registration.registeredAt) >= Date.parse(`${expectedDates[0]}T00:00:00.000Z`))
      reasons.push('REGISTRATION_DID_NOT_PRECEDE_TEST_SESSIONS')
    if ([baseline, baselineRepeat, candidate].some((arm) => arm.rows.some((row) => !row.complete)))
      reasons.push('INCOMPLETE_NATIVE_OUTCOMES_OR_COSTS')
    if ([baseline, baselineRepeat, candidate].some((arm) => arm.providerRequests === 0))
      reasons.push('NO_OBSERVED_JEV_REQUESTS')
    const deltas = []
    const repeats = []
    let candidateNet = 0n
    for (const [index, row] of baseline.rows.entries()) {
      const next = candidate.rows[index]
      const repeat = baselineRepeat.rows[index]
      if (
        !row.complete ||
        next?.complete !== true ||
        repeat?.complete !== true ||
        row.netMicros === null ||
        next.netMicros === null ||
        repeat.netMicros === null
      )
        continue
      deltas.push(BigInt(next.netMicros) - BigInt(row.netMicros))
      repeats.push(BigInt(repeat.netMicros) - BigInt(row.netMicros))
      candidateNet += BigInt(next.netMicros)
    }
    const complete = deltas.length === expectedDates.length
    const drawdown = candidate.conservativeMaximumDrawdownMicros
    if (drawdown === null) reasons.push('UNKNOWN_NATIVE_DRAWDOWN')
    else if (BigInt(drawdown) > BigInt(registration.maximumDrawdownMicros)) reasons.push('DRAWDOWN_LIMIT_EXCEEDED')
    const sum = (values: readonly bigint[]) => String(values.reduce((a, b) => a + b, 0n))
    const allocationHash = (arm: JevBacktestOutcome) =>
      hash(arm.rows.map(({ sessionDate, infrastructure, research }) => ({ sessionDate, infrastructure, research })))
    const delta = complete ? sum(deltas) : null
    const observedNetEffect =
      reasons.length > 0 || delta === null
        ? JevObservedNetEffect.Inconclusive
        : BigInt(delta) > 0n
          ? JevObservedNetEffect.Higher
          : BigInt(delta) < 0n
            ? JevObservedNetEffect.Lower
            : JevObservedNetEffect.Unchanged
    const material = {
      schemaVersion: 'bayn.jev-economic-comparison.v1',
      registrationHash: yield* hash(registration),
      nativeReportHashes: {
        baseline: baseline.reportHash,
        baselineRepeat: baselineRepeat.reportHash,
        candidate: candidate.reportHash,
      },
      operatingAllocationHashes: {
        baseline: yield* allocationHash(baseline),
        baselineRepeat: yield* allocationHash(baselineRepeat),
        candidate: yield* allocationHash(candidate),
      },
      candidateBuildReceiptHash: candidate.variantBuildReceiptHash,
      executableHashes: {
        baseline: baseline.executableSha256,
        baselineRepeat: baselineRepeat.executableSha256,
        candidate: candidate.executableSha256,
      },
      observedNetEffect,
      reasons,
      registrationEvidence: 'DECLARED_ONLY',
      registeredSessionCount: expectedDates.length,
      completePairedSessionCount: deltas.length,
      candidateNetMicros: complete ? String(candidateNet) : null,
      pairedNetDeltaMicros: delta,
      unchangedPromptNetDeltaMicros: complete ? sum(repeats) : null,
      pairedSessions: baseline.rows.map((row, index) => ({
        sessionDate: row.sessionDate,
        baselineNetMicros: row.netMicros,
        baselineRepeatNetMicros: baselineRepeat.rows[index]?.netMicros,
        candidateNetMicros: candidate.rows[index]?.netMicros,
      })),
      economicImprovement: 'UNPROVEN',
      qualification: 'UNQUALIFIED',
      adoption: 'NOT_AUTHORIZED',
      limitations: [
        'Native replay evidence is distinct from executable live capacity and provider billing reconciliation.',
        'Document hashes detect changed bytes; they do not authenticate the replay producer or verify the complete source and accounting graph.',
        'Observed totals are descriptive. Session count and one unchanged-prompt repeat do not establish statistical power or attribution.',
        'This document does not verify registration time, trial history, original arrival coverage, stressed execution or prospective confirmation.',
        'Use the frozen Jev acceptance protocol at its specified scope; this comparison defines no second statistical acceptance rule.',
      ],
    }
    return { ...material, comparisonHash: yield* hash(material) }
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev economic comparison failed', cause })))
