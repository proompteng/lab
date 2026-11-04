import { isProtectedEntryTarget, protectedEntryExpiresAtMs } from '../strategy/runtime-decision'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { makeStrategyProtocolHashResult } from '../contracts'
import { RetainedAutonomousCyclePassObservationSchema } from '../cycle/runner/pass-observation'
import { JevResearchPolicy } from '../jev/acceptance'
import { jevSignalDueAtMs, jevSignalWindowEndMs } from '../jev/observation-query'
import { NonNegativeIntegerSchema, Sha256Schema, UtcInstantSchema } from '../schemas'
import { jevProtocolIdentityMatches, type ExecutionDecisionDocument } from '../shadow-decision-contract'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import type { ScheduledEvaluation } from './policy'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { JevProtocolSchema, type JevProtocolMaterial } from '../jev/protocol'
import { qualificationCalendar } from './calendar'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { exchangeSessions, isContinuousMarket, marketHoursAreCanonical } from '../market-hours'
import { instrumentMarket, MarketKind } from '../instruments'
import { decideAccountProtection } from '../jev/account-protection'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import {
  firstIntradayObservationAtMs,
  marketCalendarQueryFromSession,
  selectIntradayExecutionSession,
} from '../cycle/runner/calendar-decisions'

export const ControllerPassEvidenceSchema = Schema.Struct({
  controllerKey: Sha256Schema,
  planHash: Sha256Schema,
  epoch: NonNegativeIntegerSchema,
  sequence: NonNegativeIntegerSchema,
  receiptHash: Sha256Schema,
  completedAt: UtcInstantSchema,
  observation: RetainedAutonomousCyclePassObservationSchema,
})
export type ControllerPassEvidence = typeof ControllerPassEvidenceSchema.Type

export const sourceFitsRegisteredSession = (
  manifest: Readonly<Record<string, unknown>>,
  registration: ScheduledEvaluation,
  observedAt: string,
) => {
  const profile = registration.obligations.configuration.protocol.marketProfiles.find(
    (profile) => profile.feed === manifest['feed'],
  )
  const native = registration.calendar.operatingHours === 'NATIVE'
  const registered = registration.calendar.sessions.find((s) =>
    native ? s.openAt <= observedAt && observedAt < s.closeAt : s.sessionDate === manifest['sessionDate'],
  )
  if (
    profile === undefined ||
    !registration.calendar.tradingMarkets.includes(profile.market) ||
    manifest['universeId'] !== profile.universeId ||
    manifest['universeSymbolHash'] !== profile.universeSymbolHash ||
    registered === undefined ||
    observedAt < registered.openAt ||
    observedAt >= registered.closeAt
  )
    return false
  const hours = Schema.decodeUnknownResult(SnapshotCalendarSchema)(manifest['calendar'])
  if (Result.isFailure(hours) || !marketHoursAreCanonical(hours.success)) return false
  if (isContinuousMarket(hours.success)) return profile.market === MarketKind.Crypto
  if (profile.market !== MarketKind.Equity) return false
  if (native)
    return exchangeSessions(hours.success).some(
      (session) =>
        session.date === manifest['sessionDate'] && session.openAt <= observedAt && observedAt < session.closeAt,
    )
  const calendar = qualificationCalendar(manifest['calendar'])
  if (Result.isFailure(calendar)) return false
  const source = calendar.success.sessions.find((s) => s.sessionDate === manifest['sessionDate'])
  return source !== undefined && source.openAt === registered.openAt && source.closeAt === registered.closeAt
}

const entryDecisionWork = (strategy: ProtectedEntryTarget, completedAt: string) => {
  const { observation } = strategy.evidence
  const exclusions = observation.manifest['candidateExclusions']
  const sourceAt = new Date(
    jevSignalDueAtMs(
      jevSignalWindowEndMs(Date.parse(observation.observedAt), observation.protocol),
      observation.protocol,
    ),
  ).toISOString()
  return {
    sourceAt,
    correct:
      completedAt >= sourceAt &&
      (strategy.schemaVersion === 'bayn.repeated-momentum-target.v1'
        ? exclusions === undefined || (Array.isArray(exclusions) && exclusions.length === 0)
        : strategy.evidence.batchPlan.candidates.every(
            (c) => c.status !== 'EXCLUDED' || (c.reason !== 'not-ready' && c.reason !== 'freshness'),
          ) &&
          strategy.evidence.batchResult.candidates.every(
            (c) =>
              c.status === 'EXCLUDED' ||
              (c.status === 'RESOLVED' &&
                c.resolution.status === 'RECORDED' &&
                c.receipt?.outcome.status === 'COMPLETED'),
          )),
  }
}

export const decisionDocumentWork = (document: ExecutionDecisionDocument, registration: ScheduledEvaluation) => {
  const strategy = document.strategyDecision
  if (isProtectedEntryTarget(strategy)) {
    const work = entryDecisionWork(strategy, document.createdAt)
    return {
      ...work,
      correct:
        work.correct &&
        sourceFitsRegisteredSession(
          strategy.evidence.observation.manifest,
          registration,
          strategy.evidence.observation.observedAt,
        ),
    }
  }
  if (strategy?.schemaVersion === 'bayn.jev-exit-target.v5')
    return {
      sourceAt: strategy.observedAt,
      correct:
        document.createdAt >= strategy.observedAt &&
        registration.calendar.sessions.some(
          (s) =>
            s.sessionDate === strategy.sessionDate &&
            s.openAt <= strategy.observedAt &&
            strategy.observedAt < s.closeAt,
        ) &&
        strategy.symbols.every(
          (symbol) =>
            registration.obligations.configuration.protocol.universe.includes(symbol) &&
            registration.calendar.tradingMarkets.includes(instrumentMarket(symbol)),
        ),
    }
  return undefined
}

export const controllerBuildMatchesRegistration = (pass: ControllerPassEvidence, registration: ScheduledEvaluation) => {
  const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
  const build = pass.observation.executionBuild
  return (
    candidate !== undefined &&
    build !== undefined &&
    build.sourceRevision === candidate.sourceRevision &&
    build.imageDigest === `sha256:${candidate.imageDigest}`
  )
}

export type ControllerBuildBindingPolicy = 'CURRENT' | 'RETAINED_OPERATIONAL_V1'

/** Frozen receipt reproduction only. New claims use controllerBuildMatchesRegistration. */
const retainedOperationalV1ControllerBuildMatches = (
  pass: ControllerPassEvidence,
  registration: ScheduledEvaluation,
) => {
  const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
  const build = pass.observation.executionBuild
  return (
    candidate !== undefined &&
    build !== undefined &&
    build.sourceRevision === candidate.sourceRevision &&
    build.imageDigest === `sha256:${candidate.imageDigest}`
  )
}

const registeredControllerOwns = (
  pass: ControllerPassEvidence,
  registration: ScheduledEvaluation,
  accountId: string,
  generationHash: string,
  protocol: JevProtocolMaterial,
  buildBinding: ControllerBuildBindingPolicy,
) =>
  Result.gen(function* () {
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const accountHash = yield* canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId })
    const identity = yield* makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId,
    })
    const historicalBehavior = sha256(
      protocol.schemaVersion === 'bayn.jev.protocol.v35' ||
        protocol.schemaVersion === 'bayn.jev.protocol.v36' ||
        protocol.schemaVersion === 'bayn.jev.protocol.v37'
        ? 'bayn.candidate-chart-entry.behavior.v1'
        : 'bayn.chart-first-entry.behavior.v1',
    )
    const historicalParameters = yield* canonicalHashV1Result(protocol)
    const historicalIdentity = yield* makeStrategyProtocolHashResult({
      name: 'jev',
      behaviorHash: historicalBehavior,
      parameterHash: historicalParameters,
      parameterSchemaVersion: protocol.schemaVersion,
    })
    return (
      candidate !== undefined &&
      (buildBinding === 'RETAINED_OPERATIONAL_V1'
        ? retainedOperationalV1ControllerBuildMatches(pass, registration)
        : controllerBuildMatchesRegistration(pass, registration)) &&
      pass.planHash === registration.obligations.configuration.controllerPlanHash &&
      pass.controllerKey === identity.identityHash &&
      candidate.accountBindingHash === accountHash &&
      candidate.authorityGenerationHash === generationHash &&
      (Schema.is(JevProtocolSchema)(protocol)
        ? jevProtocolIdentityMatches(protocol, candidate.protocolHash)
        : historicalParameters === candidate.parametersHash &&
          historicalIdentity === candidate.protocolHash &&
          historicalBehavior === candidate.strategyHash)
    )
  })

export const closedEntryWindowTimingSupported = (clock: {
  readonly issued: number
  readonly evaluated: number
  readonly available: number
  readonly decided: number
  readonly observed: number
  readonly completed: number
  readonly witnessed: number
  readonly entryEligible: boolean
}) =>
  !clock.entryEligible &&
  clock.issued <= clock.evaluated &&
  clock.evaluated <= clock.decided &&
  clock.available <= clock.decided &&
  clock.decided <= clock.observed &&
  clock.observed <= clock.completed &&
  clock.completed <= clock.witnessed

/** Reproduce an idle discovery result; a bare closed/healthy tick cannot supply decision evidence. */
export const closedEntryWindowWork = (
  pass: ControllerPassEvidence,
  registration: ScheduledEvaluation,
  witnessedAt: string,
  buildBinding: ControllerBuildBindingPolicy = 'CURRENT',
) =>
  Result.gen(function* () {
    const observation = pass.observation
    if (
      registration.calendar.operatingHours !== 'NATIVE' ||
      observation.result !== 'SUCCESS' ||
      observation.outcome !== 'WINDOW_CLOSED' ||
      observation.closedEntryWindow === undefined
    )
      return undefined
    const evidence = observation.closedEntryWindow
    const runtime = registration.obligations.configuration
    const policy = yield* makeCycleExecutionPolicyFromModel(runtime.protocol.executionModel)
    const query = yield* marketCalendarQueryFromSession(evidence.evaluatedAt.slice(0, 10))
    const session = selectIntradayExecutionSession(evidence.calendar, evidence.executionPolicy, evidence.evaluatedAt)
    const lockedCalendar = registration.calendar.marketCalendar
    const sessionDate = evidence.evaluatedAt.slice(0, 10)
    const actualSession = evidence.calendar.providerSessions.find((s) => s.date === sessionDate) ?? null
    const lockedSession = lockedCalendar.providerSessions.find((s) => s.date === sessionDate) ?? null
    const entryEligible =
      session !== undefined &&
      firstIntradayObservationAtMs(session, evidence.executionPolicy) <= Date.parse(evidence.evaluatedAt)
    return {
      sourceAt: evidence.evaluatedAt,
      correct:
        evidence.authorityGenerationHash !== null &&
        observation.executionIssuedAt !== undefined &&
        runtime.entryMarkets?.length === 1 &&
        runtime.entryMarkets[0] === MarketKind.Equity &&
        evidence.strategyProtocolHash ===
          registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)?.protocolHash &&
        evidence.executionPolicy.executionPolicyHash === policy.executionPolicyHash &&
        (yield* canonicalHashV1Result(evidence.calendar.requestedRange)) === (yield* canonicalHashV1Result(query)) &&
        (yield* canonicalHashV1Result(actualSession)) === (yield* canonicalHashV1Result(lockedSession)) &&
        marketHoursAreCanonical(evidence.calendar) &&
        evidence.calendarRead.status === 200 &&
        (yield* registeredControllerOwns(
          pass,
          registration,
          evidence.accountId,
          evidence.authorityGenerationHash,
          runtime.protocol,
          buildBinding,
        )) &&
        registration.calendar.sessions.some(
          (s) => s.openAt <= evidence.evaluatedAt && evidence.evaluatedAt < s.closeAt,
        ) &&
        closedEntryWindowTimingSupported({
          issued: Date.parse(observation.executionIssuedAt),
          evaluated: Date.parse(evidence.evaluatedAt),
          available: Date.parse(evidence.calendarRead.observedAt),
          decided: Date.parse(evidence.decidedAt),
          observed: Date.parse(observation.observedAt),
          completed: Date.parse(pass.completedAt),
          witnessed: Date.parse(witnessedAt),
          entryEligible,
        }),
    }
  })

export const entryAbstentionWork = (
  pass: ControllerPassEvidence,
  registration: ScheduledEvaluation,
  witnessedAt: string,
  buildBinding: ControllerBuildBindingPolicy = 'CURRENT',
) =>
  Result.gen(function* () {
    const observation = pass.observation
    if (observation.result !== 'SUCCESS' || observation.entryAbstention === undefined) return undefined
    const target = observation.entryAbstention
    const evidence = target.evidence
    const source = evidence.observation
    const work = entryDecisionWork(target, evidence.decidedAt)
    return {
      ...work,
      correct:
        work.correct &&
        target.selectedSymbols.length === 0 &&
        sourceFitsRegisteredSession(source.manifest, registration, source.observedAt) &&
        (yield* registeredControllerOwns(
          pass,
          registration,
          source.portfolio.brokerState.account.accountId,
          source.authorityGenerationHash,
          source.protocol,
          buildBinding,
        )) &&
        holdCompletionSupported({
          observedAt: evidence.decidedAt,
          passObservedAt: observation.observedAt,
          completedAt: pass.completedAt,
          witnessedAt,
          validUntil: new Date(protectedEntryExpiresAtMs(target)).toISOString(),
        }),
    }
  })

export const holdCompletionSupported = (evidence: {
  readonly observedAt: string
  readonly passObservedAt: string
  readonly completedAt: string
  readonly witnessedAt: string
  readonly validUntil: string
}) =>
  evidence.observedAt <= evidence.passObservedAt &&
  evidence.passObservedAt <= evidence.completedAt &&
  evidence.completedAt <= evidence.witnessedAt &&
  evidence.witnessedAt < evidence.validUntil

export const accountProtectionWork = (
  pass: ControllerPassEvidence,
  registration: ScheduledEvaluation,
  witnessedAt: string,
  buildBinding: ControllerBuildBindingPolicy = 'CURRENT',
) =>
  Result.gen(function* () {
    const observation = pass.observation
    if (observation.result !== 'SUCCESS' || observation.outcome !== 'ADMISSION_WAITING') return undefined
    const protection = observation.admissionProtection
    if (protection === undefined) return undefined
    const inputs = protection.inputs
    if (inputs === undefined) return undefined
    const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const reproduced = decideAccountProtection(inputs, protection.authorityGenerationHash)
    const { inputs: _inputs, ...summary } = protection
    return {
      sourceAt: inputs.observedAt,
      correct:
        reproduced !== undefined &&
        candidate !== undefined &&
        (yield* canonicalHashV1Result(reproduced.protection)) === (yield* canonicalHashV1Result(summary)) &&
        (yield* canonicalHashV1Result(inputs.policy)) === candidate.riskPolicyHash &&
        (yield* registeredControllerOwns(
          pass,
          registration,
          inputs.policy.accountId,
          protection.authorityGenerationHash,
          registration.obligations.configuration.protocol,
          buildBinding,
        )) &&
        registration.calendar.sessions.some((s) => s.openAt <= inputs.observedAt && inputs.observedAt < s.closeAt) &&
        inputs.observedAt === observation.observedAt &&
        holdCompletionSupported({
          observedAt: inputs.observedAt,
          passObservedAt: observation.observedAt,
          completedAt: pass.completedAt,
          witnessedAt,
          validUntil: protection.validUntil,
        }),
    }
  })

/** A successful controller tick is insufficient: reproduce the retained strategy conclusion and its owner. */
export const positionHoldWork = (
  pass: ControllerPassEvidence,
  registration: ScheduledEvaluation,
  decisions: readonly { readonly sessionDate: string; readonly document: ExecutionDecisionDocument }[],
  witnessedAt: string,
  buildBinding: ControllerBuildBindingPolicy = 'CURRENT',
) =>
  Result.gen(function* () {
    const observation = pass.observation
    if (observation.result !== 'SUCCESS' || observation.positionHold === undefined) return undefined
    const hold = observation.positionHold
    const evidence = hold.evidence
    const entry = decisions.find(({ document }) => document.contentHash === hold.entryDecisionHash)
    const accountId = evidence.portfolio.brokerState.account.accountId
    const strategy = entry?.document.strategyDecision
    const correct =
      entry !== undefined &&
      (yield* registeredControllerOwns(
        pass,
        registration,
        accountId,
        evidence.authorityGenerationHash,
        evidence.protocol,
        buildBinding,
      )) &&
      entry.document.bindings.authorityGenerationHash === evidence.authorityGenerationHash &&
      entry.document.bindings.accountId === accountId &&
      entry.document.bindings.cycleId === evidence.cycleId &&
      entry.sessionDate === evidence.sessionDate &&
      entry.document.createdAt <= evidence.observedAt &&
      sourceFitsRegisteredSession(evidence.source.manifest, registration, evidence.observedAt) &&
      holdCompletionSupported({
        observedAt: evidence.observedAt,
        passObservedAt: observation.observedAt,
        completedAt: pass.completedAt,
        witnessedAt,
        validUntil: hold.validUntil,
      }) &&
      isProtectedEntryTarget(strategy) &&
      evidence.portfolio.purpose === 'MANAGE' &&
      (yield* canonicalHashV1Result(strategy.exitPolicy)) ===
        (yield* canonicalHashV1Result(evidence.portfolio.exitPolicy))
    return { sourceAt: evidence.observedAt, correct }
  })
