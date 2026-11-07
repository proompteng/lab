import { PgClient } from '@effect/sql-pg'
import { isProtectedEntryTarget } from '../strategy/runtime-decision'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import {
  decodeExecutionDecisionDocument,
  decodeRetainedJevV38ExecutionDecisionDocument,
} from '../shadow-decision-contract'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { decisionAdmissionWitnesses, indexDecisionAdmissionMutations } from './decision-admissions'
import {
  ControllerPassEvidenceSchema,
  controllerBuildMatchesRegistration,
  decisionMarketScopeSupported,
  type ControllerBuildBindingPolicy,
} from './decision-work'
import { SystemAssessmentError } from './economics'
import { executionOrderPlans, protectionIntentsByDecision } from './execution-plans'
import { earliestDurableWitnesses } from './obligation-witnesses'
import { bindOperationalWork, registeredControllerWork, registeredDecisionWork } from './operational-obligations'
import { type OperationalRegistration, verifyStoredOperationalRegistration } from './operational-period'
import { readSystemSourceCutPayload, SystemSourceCutSchema } from './source-cut'
import { RecordedSystemSourceCutSchema } from './recorded-source-cut'
import { readSystemSourceRecord, SystemSourceRecordKind } from './source-records'
import { makeOperationalSafetyScan, type NativeOperationalSafetyAudit } from './operational-safety'

export const OperationalSourceReferenceSchema = Schema.Struct({
  kind: Schema.Enum(SystemSourceRecordKind),
  sourceId: Sha256Schema,
  recordHash: Sha256Schema,
})
type SourceReference = typeof OperationalSourceReferenceSchema.Type

export const OperationalSourceCutSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operational-source-cut.v1'),
  registrationHash: Sha256Schema,
  asOf: UtcInstantSchema,
  runtimeConfigurationHash: Sha256Schema,
  financial: SystemSourceCutSchema.fields.financial,
  records: Schema.Array(OperationalSourceReferenceSchema),
  protectionIntents: SystemSourceCutSchema.fields.protectionIntents,
  decisionAdmissions: SystemSourceCutSchema.fields.decisionAdmissions,
  mutations: SystemSourceCutSchema.fields.mutations,
  durableObservations: SystemSourceCutSchema.fields.durableObservations,
  sourceMaterial: Schema.Unknown,
  sourceMaterialHash: Sha256Schema,
})
export type OperationalSourceCut = typeof OperationalSourceCutSchema.Type

export const persistOperationalSourceCut = (input: unknown) =>
  Effect.gen(function* () {
    const cut = yield* Schema.decodeUnknownEffect(OperationalSourceCutSchema, strictParseOptions)(input)
    if ((yield* Effect.fromResult(canonicalHashV1Result(cut.sourceMaterial))) !== cut.sourceMaterialHash)
      return yield* new SystemAssessmentError({ message: 'Operational source material digest differs' })
    const sourceCutHash = yield* Effect.fromResult(canonicalHashV1Result(cut))
    const text = yield* Effect.fromResult(canonicalJsonV1Result(cut))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO system_evidence_cuts(source_cut_hash, registration_hash, as_of, payload_text)
    VALUES (${sourceCutHash}, ${cut.registrationHash}, ${cut.asOf}, ${text}) ON CONFLICT (source_cut_hash) DO NOTHING`
    return { sourceCutHash, cut }
  }).pipe(
    Effect.mapError(
      (cause) => new SystemAssessmentError({ message: 'Operational source cut persistence failed', cause }),
    ),
  )

// A stored manifest carries source references, never trusted correctness claims.
const verified = Symbol('verified operational sources')
export type VerifiedOperationalSourceCut = {
  readonly [verified]: true
  readonly cut: OperationalSourceCut
  readonly buildBinding: ControllerBuildBindingPolicy
  readonly unboundControllerBuilds: readonly {
    readonly receiptHash: string
    readonly completedAt: string
    readonly executionIssuedAt: string | undefined
    readonly observedAt: string
  }[]
  readonly work: Parameters<typeof bindOperationalWork>[3]
  readonly admissions: Result.Result.Success<ReturnType<typeof decisionAdmissionWitnesses>>
  readonly nativeSafetyAudit: NativeOperationalSafetyAudit
}

export const isVerifiedOperationalSourceCut = (
  cut: VerifiedOperationalSourceCut | typeof RecordedSystemSourceCutSchema.Type,
): cut is VerifiedOperationalSourceCut => verified in cut && cut[verified] === true

const readDecision = (reference: SourceReference, registration: OperationalRegistration) =>
  Effect.gen(function* () {
    const record = yield* readSystemSourceRecord(reference.recordHash)
    if (record.kind !== SystemSourceRecordKind.Decision || reference.kind !== record.kind)
      return yield* new SystemAssessmentError({ message: 'Decision source record kind differs' })
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ sessionDate: IsoDateSchema, document: Schema.Unknown }),
      strictParseOptions,
    )(record.payload)
    const document =
      registration.obligations.configuration.protocol.schemaVersion === 'bayn.jev.protocol.v38'
        ? yield* Effect.fromResult(decodeRetainedJevV38ExecutionDecisionDocument(row.document))
        : yield* Effect.fromResult(decodeExecutionDecisionDocument(row.document))
    if (document.contentHash !== reference.sourceId)
      return yield* new SystemAssessmentError({ message: 'Decision source identity differs' })
    if (!decisionMarketScopeSupported(document, registration))
      return yield* new SystemAssessmentError({ message: 'Decision source market scope differs from registration' })
    return { ...row, document }
  })

const readController = (reference: SourceReference) =>
  Effect.gen(function* () {
    const record = yield* readSystemSourceRecord(reference.recordHash)
    if (record.kind !== SystemSourceRecordKind.Controller || reference.kind !== record.kind)
      return yield* new SystemAssessmentError({ message: 'Controller source record kind differs' })
    const pass = yield* Schema.decodeUnknownEffect(ControllerPassEvidenceSchema, strictParseOptions)(record.payload)
    if (pass.receiptHash !== reference.sourceId)
      return yield* new SystemAssessmentError({ message: 'Controller source identity differs' })
    return pass
  })

export const replayOperationalSourceRecords = (
  cut: OperationalSourceCut,
  registration: OperationalRegistration,
  buildBinding: ControllerBuildBindingPolicy = 'CURRENT',
) =>
  Effect.gen(function* () {
    const decisions = new Map<string, SourceReference>()
    const controllers = new Map<string, SourceReference>()
    const indexes = {
      [SystemSourceRecordKind.Decision]: decisions,
      [SystemSourceRecordKind.Controller]: controllers,
    }
    for (const reference of cut.records) {
      const index = indexes[reference.kind]
      if (index.has(reference.sourceId))
        return yield* new SystemAssessmentError({ message: 'Operational source identity is repeated' })
      index.set(reference.sourceId, reference)
    }
    const protectionsByDecision = protectionIntentsByDecision(cut.protectionIntents)
    const safety = yield* Effect.fromResult(makeOperationalSafetyScan(cut, registration))
    const documentWork = new Map<string, ReturnType<typeof registeredDecisionWork>>()
    const intentOwners = new Set<string>()
    const retainedProtections = new Set<string>()
    for (const reference of decisions.values()) {
      const row = yield* readDecision(reference, registration)
      const protections = protectionsByDecision.get(row.document.contentHash) ?? []
      const plans = yield* Effect.fromResult(executionOrderPlans([row], protections))
      yield* Effect.fromResult(safety.consume(plans))
      for (const intentId of plans.keys()) {
        if (intentOwners.has(intentId))
          return yield* new SystemAssessmentError({ message: 'Ambiguous execution intent ownership' })
        intentOwners.add(intentId)
      }
      for (const protection of protections) retainedProtections.add(protection.intentId)
      documentWork.set(row.document.contentHash, registeredDecisionWork(row.document, registration))
    }
    if (cut.protectionIntents.some((protection) => !retainedProtections.has(protection.intentId)))
      return yield* new SystemAssessmentError({ message: 'Protection source has no retained entry decision' })

    const admissions: Result.Result.Success<ReturnType<typeof decisionAdmissionWitnesses>> = {
      sources: new Set<string>(),
      witnesses: [],
    }
    const mutationIndex = indexDecisionAdmissionMutations(cut.mutations)
    const admissionKeys = new Set<string>()
    for (const receipt of cut.decisionAdmissions) {
      const reference = decisions.get(receipt.decisionId)
      const key = `${receipt.eventId}:${receipt.decisionId}`
      if (reference === undefined || admissionKeys.has(key))
        return yield* new SystemAssessmentError({ message: 'Decision admission has no unique retained source' })
      admissionKeys.add(key)
      const row = yield* readDecision(reference, registration)
      const derived = yield* Effect.fromResult(
        decisionAdmissionWitnesses(
          {
            asOf: cut.asOf,
            decisions: [row],
            protectionIntents: protectionsByDecision.get(row.document.contentHash) ?? [],
            decisionAdmissions: [receipt],
          },
          registration.policies[0].authorityGenerationHash,
          mutationIndex,
        ),
      )
      for (const source of derived.sources) admissions.sources.add(source)
      admissions.witnesses.push(...derived.witnesses)
    }

    const controllerWork = new Map<
      string,
      NonNullable<Result.Result.Success<ReturnType<typeof registeredControllerWork>>>
    >()
    const unboundControllerBuilds: VerifiedOperationalSourceCut['unboundControllerBuilds'][number][] = []
    const witnesses = earliestDurableWitnesses(cut)
    for (const reference of controllers.values()) {
      const pass = yield* readController(reference)
      // Retain only small provenance/timing evidence, including passes with no durable work witness.
      if (!controllerBuildMatchesRegistration(pass, registration))
        unboundControllerBuilds.push({
          receiptHash: pass.receiptHash,
          completedAt: pass.completedAt,
          executionIssuedAt: pass.observation.executionIssuedAt,
          observedAt: pass.observation.observedAt,
        })
      const witness = witnesses.get(`CONTROLLER:${pass.receiptHash}:${pass.completedAt}`)
      if (witness === undefined) continue
      const entryReference =
        pass.observation.result === 'SUCCESS' && pass.observation.positionHold !== undefined
          ? decisions.get(pass.observation.positionHold.entryDecisionHash)
          : undefined
      const entry = entryReference === undefined ? [] : [yield* readDecision(entryReference, registration)]
      const work = yield* Effect.fromResult(
        registeredControllerWork(pass, registration, entry, witness.witnessedAt, buildBinding),
      )
      if (work !== undefined) controllerWork.set(pass.receiptHash, work)
    }
    return {
      [verified]: true,
      cut,
      buildBinding,
      unboundControllerBuilds,
      work: { documentWork, controllerWork },
      admissions,
      nativeSafetyAudit: yield* Effect.fromResult(safety.finish()),
    } satisfies VerifiedOperationalSourceCut
  })

export const readOperationalAssessmentSourceCut = (
  hash: string,
  registration: OperationalRegistration,
  buildBinding: ControllerBuildBindingPolicy = 'CURRENT',
) =>
  Effect.gen(function* () {
    const value = yield* readSystemSourceCutPayload(hash)
    const cut = yield* Schema.decodeUnknownEffect(
      Schema.Union([RecordedSystemSourceCutSchema, OperationalSourceCutSchema]),
      strictParseOptions,
    )(value)
    if ((yield* Effect.fromResult(canonicalHashV1Result(cut))) !== hash)
      return yield* new SystemAssessmentError({ message: 'Operational source cut digest differs' })
    const { registrationHash } = yield* Effect.fromResult(verifyStoredOperationalRegistration(registration))
    if (
      cut.registrationHash !== registrationHash ||
      cut.runtimeConfigurationHash !== registration.obligations.runtimeConfigurationHash ||
      (yield* Effect.fromResult(canonicalHashV1Result(cut.sourceMaterial))) !== cut.sourceMaterialHash
    )
      return yield* new SystemAssessmentError({ message: 'Operational source cut differs from its registration' })
    if (cut.schemaVersion === 'bayn.system-source-cut.v4') {
      if (
        cut.decisions.some(({ document }) => {
          const target = document.strategyDecision
          const protocol =
            target?.schemaVersion === 'bayn.jev-exit-target.v5'
              ? target.evidence.protocol
              : isProtectedEntryTarget(target)
                ? target.evidence.observation.protocol
                : undefined
          return (
            protocol !== undefined &&
            protocol.schemaVersion !== registration.obligations.configuration.protocol.schemaVersion
          )
        })
      )
        return yield* new SystemAssessmentError({
          message: 'Stored operational decisions mix strategy protocol versions',
        })
      return cut
    }
    return yield* replayOperationalSourceRecords(cut, registration, buildBinding)
  }).pipe(
    Effect.mapError((cause) => new SystemAssessmentError({ message: 'Operational source verification failed', cause })),
  )
