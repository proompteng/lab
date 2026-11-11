import { Result, Schema } from 'effect'

import { BrokerIdentitySchema } from '../broker/identity'
import { AccountStatus, Authority, KillState } from '../execution/contracts'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { canonicalHashV1Result } from '../hash'
import { AccountProtectionInputsSchema } from '../jev/account-protection'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { nativeArrivalCaptureId } from '../market-data/streaming/native-arrival'
import { PolicySchema } from '../risk'
import { Sha256Schema, UnsignedMicrosSchema, strictParseOptions } from '../schemas'
import { accountTradingDate } from '../time'
import { BacktestInputSchema } from './backtest'
import { ControlStudyFailure } from './control-portfolio'
import { ControlEntryMode, ControlManagementMode, ControlStudyInputSchema, prepareControlStudy } from './control-study'
import { NativeArrivalExportManifestSchema } from './native-arrival-export'
import { validateBacktestSourceManifest, type BacktestSourceReceipt } from './source'

const { source: _source, openingCashMicros: _cash, ...backtestTemplateFields } = BacktestInputSchema.fields
const {
  backtest: _backtest,
  openingPeakEquityMicros: _peak,
  ridge: _ridge,
  falsificationCandidate: _falsification,
  ...controlTemplateFields
} = ControlStudyInputSchema.fields

/** Freeze these bytes independently before the session; binding supplies no timestamp authentication. */
export const ControlStudyPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.control-study-plan.v1'),
  candidate: Schema.Struct({
    broker: BrokerIdentitySchema,
    requestHash: Sha256Schema,
    authorityGenerationHash: Sha256Schema,
    riskPolicy: PolicySchema,
  }),
  controlTemplate: Schema.Struct({
    ...controlTemplateFields,
    entry: Schema.Literal(ControlEntryMode.Deterministic),
    management: Schema.Literal(ControlManagementMode.Mechanical),
    backtest: Schema.Struct(backtestTemplateFields),
  }),
})

export const ControlStudyOpeningSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.control-study-opening.v1'),
  broker: BrokerIdentitySchema,
  requestHash: Sha256Schema,
  build: BacktestInputSchema.fields.build,
  inputs: AccountProtectionInputsSchema,
  dailyTradedNotionalMicros: UnsignedMicrosSchema,
})

/** Derive capital from retained native preflight inputs, never a researcher-supplied starting balance. */
export const bindControlStudyInput = (
  rawPlan: unknown,
  rawOpening: unknown,
  rawExport: unknown,
  rawSource: unknown,
  receipt: BacktestSourceReceipt,
) =>
  Result.gen(function* () {
    const plan = yield* Schema.decodeUnknownResult(ControlStudyPlanSchema, strictParseOptions)(rawPlan)
    const opening = yield* Schema.decodeUnknownResult(ControlStudyOpeningSchema, strictParseOptions)(rawOpening)
    const exported = yield* Schema.decodeUnknownResult(NativeArrivalExportManifestSchema, strictParseOptions)(rawExport)
    const source = yield* validateBacktestSourceManifest(rawSource)
    const fail = (message: string) => Result.fail(new ControlStudyFailure({ message }))
    const { candidate, controlTemplate } = plan
    const { inputs } = opening
    const { brokerState } = inputs.portfolio
    const build = controlTemplate.backtest.build
    const { verification, ...captureBuild } = exported.epoch.build
    if (
      verification !== 'embedded' ||
      (yield* canonicalHashV1Result(captureBuild)) !== (yield* canonicalHashV1Result(build)) ||
      (yield* canonicalHashV1Result(opening.build)) !== (yield* canonicalHashV1Result(build))
    )
      return yield* fail('Candidate, opening and original capture must have the same embedded build')
    if (
      source.transport !== 'original-capture' ||
      source.deliveryModel.schemaVersion !== 'bayn.original-capture-arrivals.v1' ||
      source.dataSha256 !== exported.dataSha256 ||
      source.deliveryModel.exportManifestHash !== (yield* canonicalHashV1Result(exported)) ||
      source.deliveryModel.captureId !== exported.epoch.captureId ||
      source.deliveryModel.consumerEpoch !== exported.epoch.bootstrap.epoch ||
      (yield* nativeArrivalCaptureId(exported.epoch.build, exported.epoch.bootstrap, exported.epoch.sources)) !==
        exported.epoch.captureId
    )
      return yield* fail('Source must bind the unchanged original native export')
    const nativePolicy = yield* makeExecutionRiskPolicy(
      candidate.broker.accountId,
      defaultJevProtocolDocument.universe,
      candidate.broker.environment,
    )
    const policyHash = yield* canonicalHashV1Result(candidate.riskPolicy)
    if (
      candidate.broker.identityHash !== opening.broker.identityHash ||
      candidate.broker.environment !== controlTemplate.riskEnvironment ||
      candidate.requestHash !== opening.requestHash ||
      candidate.authorityGenerationHash !== inputs.authority.generationHash ||
      inputs.policy.accountId !== candidate.broker.accountId ||
      brokerState.account.accountId !== candidate.broker.accountId ||
      policyHash !== (yield* canonicalHashV1Result(inputs.policy)) ||
      policyHash !== (yield* canonicalHashV1Result(nativePolicy))
    )
      return yield* fail('Opening account, request, authority or native risk policy differs from the frozen plan')
    if (
      !inputs.accountingExact ||
      brokerState.account.status !== AccountStatus.Active ||
      inputs.unknownMutationCount !== 0 ||
      inputs.authority.maximum !== Authority.Execution ||
      inputs.authority.effective !== Authority.Execution ||
      inputs.authority.kill !== KillState.Clear ||
      inputs.reconciliation.discrepancies.length !== 0 ||
      inputs.reconciliation.expectedHash !== inputs.reconciliation.observedHash ||
      (yield* canonicalHashV1Result(inputs.reconciliation)) !==
        (yield* canonicalHashV1Result(brokerState.reconciliation))
    )
      return yield* fail('Opening requires exact native accounting, settled state and unchanged PAPER authority')
    const input = {
      ...controlTemplate,
      openingPeakEquityMicros: inputs.peakEquityMicros,
      backtest: { ...controlTemplate.backtest, source, openingCashMicros: brokerState.account.cashMicros },
    }
    const study = yield* prepareControlStudy(input, receipt)
    const first = study.prepared.brokerSessions[0]
    const last = study.prepared.brokerSessions.at(-1)
    if (
      first === undefined ||
      last === undefined ||
      Date.parse(first.openAt) !== Date.parse(controlTemplate.backtest.interval.startAt) ||
      Date.parse(last.closeAt) !== Date.parse(controlTemplate.backtest.interval.endAt)
    )
      return yield* fail('Comparison interval must span exact regular-session boundaries')
    const openMs = Date.parse(first.openAt)
    const observedMs = Date.parse(inputs.observedAt)
    const observations = [
      inputs.observedAt,
      inputs.authorityObservedAt,
      brokerState.account.observedAt,
      brokerState.positionsObservedAt,
      brokerState.ordersObservedAt,
      inputs.reconciliation.reconciledAt,
    ].map(Date.parse)
    if (
      inputs.tradingDate !== accountTradingDate(controlTemplate.backtest.interval.startAt) ||
      observations.some((at) => at > observedMs || at > openMs || openMs - at >= inputs.policy.maxBrokerStateAgeMs) ||
      Date.parse(inputs.authority.updatedAt) > Date.parse(inputs.authorityObservedAt)
    )
      return yield* fail('Opening observations must be fresh at the first session boundary and available before open')
    if (BigInt(brokerState.account.buyingPowerMicros) < BigInt(brokerState.account.cashMicros))
      return yield* fail('Opening cash must be fully available in native buying power')
    if (
      BigInt(opening.dailyTradedNotionalMicros) !== 0n ||
      (inputs.schemaVersion === 'bayn.account-protection-inputs.v2' &&
        BigInt(inputs.dailyTradedNotionalMicros) !== BigInt(opening.dailyTradedNotionalMicros)) ||
      inputs.dayStartEquityMicros !== brokerState.account.equityMicros ||
      brokerState.account.cashMicros !== brokerState.account.equityMicros
    )
      return yield* fail('Opening cannot reset used daily turnover, used daily loss or noncash equity')
    return study.input
  }).pipe(
    Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot bind prospective control inputs', cause })),
  )
