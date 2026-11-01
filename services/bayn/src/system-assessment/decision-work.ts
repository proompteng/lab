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
import type { SystemRegistration } from './policy'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { JevProtocolSchema, type JevProtocolMaterial } from '../jev/protocol'
import { qualificationCalendar } from './calendar'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { isContinuousMarket, marketHoursAreCanonical } from '../market-hours'
import { instrumentMarket, MarketKind } from '../instruments'
import { decideAccountProtection } from '../jev/account-protection'

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
  registration: SystemRegistration,
  observedAt: string,
) => {
  const profile = registration.obligations.configuration.protocol.marketProfiles.find(
    (profile) => profile.feed === manifest['feed'],
  )
  const registered = registration.calendar.sessions.find((s) => s.sessionDate === manifest['sessionDate'])
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

export const decisionDocumentWork = (document: ExecutionDecisionDocument, registration: SystemRegistration) => {
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

const registeredControllerOwns = (
  pass: ControllerPassEvidence,
  registration: SystemRegistration,
  accountId: string,
  generationHash: string,
  protocol: JevProtocolMaterial,
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
      protocol.schemaVersion === 'bayn.jev.protocol.v35'
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

export const entryAbstentionWork = (
  pass: ControllerPassEvidence,
  registration: SystemRegistration,
  witnessedAt: string,
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
  registration: SystemRegistration,
  witnessedAt: string,
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
  registration: SystemRegistration,
  decisions: readonly { readonly sessionDate: string; readonly document: ExecutionDecisionDocument }[],
  witnessedAt: string,
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
