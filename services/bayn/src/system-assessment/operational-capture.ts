import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Schema } from 'effect'

import { BrokerEnvironment } from '../broker/identity'
import { openSnapshotRows } from '../db/snapshot-rows'
import type { ForwardPerformanceConfig } from '../forward-performance/config'
import { readForwardPerformanceInput } from '../forward-performance/program'
import { canonicalHashV1Result } from '../hash'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { verifyInferenceExpenseCoverage } from '../inference-expense'
import { readInferenceExpenseLedger } from '../inference-expense-journal'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { JevResearchPolicy } from '../jev/acceptance'
import { instrumentMarket } from '../instruments'
import { UtcInstantSchema, strictParseOptions } from '../schemas'
import { loadActiveStrategyProtocol } from '../strategy'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { utcInstantFromEpochMillis } from '../time'
import { readRegisteredFinancialIdentity } from './capital-identity'
import {
  readSystemDecisionAdmissions,
  readSystemDurableObservations,
  readSystemMutationEvidence,
  systemControllerPassQuery,
  systemDecisionQuery,
} from './capture-queries'
import { qualificationRuntime } from './configuration'
import { decisionMarketScopeSupported } from './decision-work'
import { SystemAssessmentError } from './economics'
import { readSystemExecutionFills, readSystemProtectionIntents } from './execution-capture'
import { captureExecutionFills } from './execution-evidence'
import { executionOrderPlans, protectionIntentsByDecision } from './execution-plans'
import { captureForwardFinancialEvidence } from './forward-evidence'
import { captureInferenceSnapshot } from './inference-capture'
import type { OperationalRegistration } from './operational-period'
import {
  type OperationalSourceCut,
  OperationalSourceCutSchema,
  persistOperationalSourceCut,
} from './operational-source-cut'
import { SystemSourceCutSchema } from './source-cut'
import { makeSystemSourceRecord, persistSystemSourceRecord, SystemSourceRecordKind } from './source-records'

export const makeOperationalSourceSpool = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-operational-sources-' })
  yield* fs.chmod(directory, 0o700)
  const references = new Map<string, OperationalSourceCut['records'][number]>()
  const spool = (kind: SystemSourceRecordKind, sourceId: string, payload: unknown) =>
    Effect.gen(function* () {
      const record = yield* Effect.fromResult(makeSystemSourceRecord(kind, payload))
      const key = `${kind}:${sourceId}`
      const previous = references.get(key)
      if (previous !== undefined) {
        if (previous.recordHash !== record.recordHash)
          return yield* new SystemAssessmentError({
            message: 'Native source identity has conflicting contents',
            cause: { kind, sourceId, retainedHash: previous.recordHash, conflictingHash: record.recordHash },
          })
        return
      }
      yield* fs.writeFileString(`${directory}/${record.recordHash}`, record.payloadText, {
        flag: 'wx',
        mode: 0o600,
      })
      references.set(key, { kind, sourceId, recordHash: record.recordHash })
    })
  const persist = Effect.gen(function* () {
    for (const reference of references.values()) {
      const path = `${directory}/${reference.recordHash}`
      const payloadText = yield* fs.readFileString(path)
      yield* persistSystemSourceRecord({ recordHash: reference.recordHash, kind: reference.kind, payloadText })
      yield* fs.remove(path)
    }
  })
  return { references, spool, persist }
})

export const captureOperationalSourceCut = (
  config: ForwardPerformanceConfig,
  registrationHash: string,
  registration: OperationalRegistration,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const definition = registration.policies[0]
      const identity = config.execution.brokerIdentity
      const first = registration.calendar.sessions[0]
      const last = registration.calendar.sessions.at(-1)
      const runtimeConfiguration = qualificationRuntime(config, yield* Effect.fromResult(loadActiveStrategyProtocol()))
      const runtimeConfigurationHash = yield* Effect.fromResult(canonicalHashV1Result(runtimeConfiguration))
      if (
        identity === undefined ||
        identity.environment !== BrokerEnvironment.Sandbox ||
        first === undefined ||
        last === undefined ||
        runtimeConfigurationHash !== registration.obligations.runtimeConfigurationHash
      )
        return yield* new SystemAssessmentError({
          message: 'Operational capture requires the registered PAPER runtime and calendar',
        })
      const accountIdentity = yield* readRegisteredFinancialIdentity(definition)
      if (accountIdentity === null || accountIdentity.identityHash !== identity.identityHash)
        return yield* new SystemAssessmentError({
          message: 'Operational capture account differs from its capital binding',
        })
      const { references, spool, persist } = yield* makeOperationalSourceSpool
      const sql = yield* PgClient.PgClient
      const client = yield* makeTigerBeetleRequestClient(config)
      const cut = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          const times = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ asOf: UtcInstantSchema })))(
            yield* sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf"`,
          )
          const asOf = times[0]?.asOf
          if (asOf === undefined)
            return yield* new SystemAssessmentError({ message: 'Database snapshot time is unavailable' })
          const scope = {
            accountId: identity.accountId,
            generationHash: definition.authorityGenerationHash,
            openAt: first.openAt,
            firstSession: first.sessionDate,
            lastSession: last.sessionDate,
            asOf,
          }
          const forward = yield* readForwardPerformanceInput(config, undefined, {
            authorityGenerationHash: definition.authorityGenerationHash,
          })
          if (
            forward.transactions.some(
              (t) =>
                t.occurredAt >= first.openAt &&
                t.occurredAt <= last.closeAt &&
                (t.symbol === undefined ||
                  !registration.obligations.configuration.protocol.universe.includes(t.symbol) ||
                  !registration.calendar.tradingMarkets.includes(instrumentMarket(t.symbol))),
            )
          )
            return yield* new SystemAssessmentError({
              message: 'Captured market scope is incompatible with the registered policy and session windows',
            })
          const protectionIntents = yield* readSystemProtectionIntents(scope, definition.riskPolicy.maxBrokerStateAgeMs)
          const rawFills = yield* readSystemExecutionFills(scope, first.openAt, last.closeAt)
          const protectionsByDecision = protectionIntentsByDecision(protectionIntents)
          const fillsByIntent = new Map<string, { observation: (typeof rawFills)[number]; index: number }[]>()
          for (const [index, observation] of rawFills.entries()) {
            const intentId = observation.fill.intentId
            if (intentId === undefined) continue
            const entries = fillsByIntent.get(intentId)
            if (entries === undefined) fillsByIntent.set(intentId, [{ observation, index }])
            else entries.push({ observation, index })
          }
          const capturedFills = new Map<number, (typeof SystemSourceCutSchema.Type)['fills'][number]>()
          const decisions: { sessionDate: string; decisionHash: string }[] = []
          const consumeDecisions = yield* openSnapshotRows(sql, systemDecisionQuery(sql, scope))
          yield* consumeDecisions((input) =>
            Effect.gen(function* () {
              const row = yield* Schema.decodeUnknownEffect(
                SystemSourceCutSchema.fields.decisions.value,
                strictParseOptions,
              )(input)
              if (!decisionMarketScopeSupported(row.document, registration))
                return yield* new SystemAssessmentError({
                  message: 'Captured market scope is incompatible with the registered policy and session windows',
                })
              const protections = protectionsByDecision.get(row.document.contentHash) ?? []
              const plans = yield* Effect.fromResult(executionOrderPlans([row], protections))
              const matched = [...plans.keys()]
                .flatMap((intentId) => fillsByIntent.get(intentId) ?? [])
                .sort((a, b) => a.index - b.index)
              const fills = yield* Effect.fromResult(
                captureExecutionFills(
                  plans,
                  matched.map(({ observation }) => observation),
                  identity.accountId,
                  definition.authorityGenerationHash,
                ),
              )
              for (const [index, match] of matched.entries()) {
                const fill = fills[index]
                if (fill === undefined || capturedFills.has(match.index))
                  return yield* new SystemAssessmentError({ message: 'Fill does not have one complete native owner' })
                capturedFills.set(match.index, fill)
              }
              yield* spool(SystemSourceRecordKind.Decision, row.document.contentHash, row)
              decisions.push({ sessionDate: row.sessionDate, decisionHash: row.document.contentHash })
            }),
          )
          if (capturedFills.size !== rawFills.length)
            return yield* new SystemAssessmentError({ message: 'Operational fill ownership coverage is incomplete' })
          const fills = [...capturedFills].sort(([a], [b]) => a - b).map(([, fill]) => fill)
          const protectionDecisions = yield* Effect.forEach(protectionIntents, (intent) =>
            Effect.gen(function* () {
              const session = registration.calendar.sessions.find(
                (s) => s.openAt <= intent.riskDecision.decidedAt && intent.riskDecision.decidedAt <= s.closeAt,
              )
              if (session === undefined)
                return yield* new SystemAssessmentError({
                  message: 'Protection approval falls outside the registered sessions',
                })
              return { sessionDate: session.sessionDate, decisionHash: intent.intentId }
            }),
          )
          const financial = yield* Effect.fromResult(
            captureForwardFinancialEvidence(registration, JevResearchPolicy.Candidate, forward, {
              decisions: [...decisions, ...protectionDecisions],
              fills,
            }),
          )
          const store = makeInferenceExpenseStore(sql, identity.accountId)
          const inferenceSnapshots = yield* Effect.forEach(registration.calendar.sessions, ({ sessionDate }) =>
            Effect.gen(function* () {
              const snapshot = yield* readInferenceExpenseSnapshot(sql, identity.accountId, sessionDate)
              yield* Effect.fromResult(
                verifyInferenceExpenseCoverage(snapshot.evidence, identity.accountId, snapshot.quotes),
              )
              const ledger = yield* readInferenceExpenseLedger(client, snapshot, store.currentSession(sessionDate))
              return { ...captureInferenceSnapshot(snapshot, registration.program).source, ledger }
            }),
          )
          const mutations = yield* readSystemMutationEvidence(
            identity.accountId,
            definition.authorityGenerationHash,
            first.openAt,
          )
          const durableObservations = yield* readSystemDurableObservations(registrationHash)
          const decisionAdmissions = yield* readSystemDecisionAdmissions(scope)
          const closeAt = utcInstantFromEpochMillis(
            Date.parse(last.closeAt) +
              Math.max(registration.obligations.decisionWindowMs, registration.obligations.reconciliationFreshnessMs),
          )
          const consumeControllers = yield* openSnapshotRows(
            sql,
            systemControllerPassQuery(
              sql,
              identity.identityHash,
              registration.obligations.configuration.controllerPlanHash,
              first.openAt,
              closeAt,
              asOf,
            ),
          )
          yield* consumeControllers((input) =>
            Effect.gen(function* () {
              const pass = yield* Schema.decodeUnknownEffect(
                SystemSourceCutSchema.fields.controllerPasses.value,
                strictParseOptions,
              )(input)
              yield* spool(SystemSourceRecordKind.Controller, pass.receiptHash, pass)
            }),
          )
          const sourceMaterial = {
            captureBuild: {
              sourceRevision: config.build.sourceRevision,
              imageRepository: config.build.imageRepository,
              imageDigest: config.build.imageDigest,
            },
            runtimeConfiguration,
            accounts: [{ policy: JevResearchPolicy.Candidate, identity: accountIdentity, forward, inferenceSnapshots }],
            mutations,
          }
          return yield* Schema.decodeUnknownEffect(
            OperationalSourceCutSchema,
            strictParseOptions,
          )({
            schemaVersion: 'bayn.operational-source-cut.v1',
            registrationHash,
            asOf,
            runtimeConfigurationHash,
            financial: [financial],
            records: [...references.values()],
            protectionIntents,
            mutations,
            durableObservations,
            decisionAdmissions,
            sourceMaterial,
            sourceMaterialHash: yield* Effect.fromResult(canonicalHashV1Result(sourceMaterial)),
          })
        }),
      )
      yield* persist
      return yield* persistOperationalSourceCut(cut)
    }),
  ).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'Operational source capture failed', cause })))
