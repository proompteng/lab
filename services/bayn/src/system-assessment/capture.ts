import {
  readSystemCashObservations,
  readSystemBatchEvidence,
  readSystemMutationEvidence,
  readSystemControllerPasses,
  readSystemDurableObservations,
  readSystemDecisionAdmissions,
  systemDecisionQuery,
} from './capture-queries'
import { readRegisteredFinancialIdentity } from './capital-identity'
import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { readForwardPerformanceInput } from '../forward-performance/program'
import type { ForwardPerformanceConfig } from '../forward-performance/config'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { verifyInferenceExpenseCoverage } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { JevResearchPolicy } from '../jev/acceptance'
import { instrumentMarket } from '../instruments'
import { UtcInstantSchema } from '../schemas'
import { readAssessmentRegistration } from './postgres'
import { SystemAssessmentError } from './economics'
import { captureForwardFinancialEvidence } from './forward-evidence'
import { SystemSourceCutSchema, persistSystemSourceCut } from './source-cut'
import { loadActiveStrategyProtocol } from '../strategy'
import { captureQualificationRuntime, qualificationRuntime } from './configuration'
import { BrokerEnvironment } from '../broker/identity'
import { registeredMarkIntervalMs } from './policy'
import { measureControllerLatency } from './controller-latency'
import { measureFullBatchLatency } from './full-batch-latency'
import { decisionMarketScopeSupported } from './decision-work'
import { prepareValuationInventory, requiredValuationTimes } from './valuation'
import { executableBid, readValuationQuotes } from './valuation-quotes'
import { captureExecutionOrders, captureExecutionFills } from './execution-evidence'
import { readSystemExecutionOrders, readSystemExecutionFills, readSystemProtectionIntents } from './execution-capture'
import { executionOrderPlans } from './execution-plans'
import { captureInferenceSnapshot } from './inference-capture'
import { captureOperationalSourceCut } from './operational-capture'

/** Capture one database snapshot. External ledger verification can reject a moving or incomplete cut. */
export const captureSystemSourceCut = (config: ForwardPerformanceConfig, registrationHash: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registration = yield* readAssessmentRegistration(registrationHash)
      if (registration.program === 'BAYN_OPERATIONAL_RELIABILITY')
        return yield* captureOperationalSourceCut(config, registrationHash, registration)
      const { runtimeConfiguration, runtimeConfigurationHash } = yield* Effect.fromResult(
        captureQualificationRuntime(
          qualificationRuntime(config, yield* Effect.fromResult(loadActiveStrategyProtocol())),
          registration.obligations,
        ),
      )
      const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
      const identity = config.execution.brokerIdentity
      const first = registration.calendar.sessions[0]
      const last = registration.calendar.sessions.at(-1)
      if (
        candidate === undefined ||
        identity === undefined ||
        identity.environment !== BrokerEnvironment.Sandbox ||
        first === undefined ||
        last === undefined
      )
        return yield* new SystemAssessmentError({
          message: 'Source capture requires a registered candidate and broker identity',
        })
      const sql = yield* PgClient.PgClient
      const cut = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          const times = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ asOf: UtcInstantSchema })))(
            yield* sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf"`,
          )
          const asOf = times[0]?.asOf
          if (asOf === undefined)
            return yield* new SystemAssessmentError({ message: 'Database snapshot time is unavailable' })
          const client = yield* makeTigerBeetleRequestClient(config)
          const accounts = []
          for (const definition of registration.policies) {
            const accountIdentity = yield* readRegisteredFinancialIdentity(definition)
            if (accountIdentity === null) continue
            if (
              definition.policy === JevResearchPolicy.Candidate &&
              accountIdentity.identityHash !== identity.identityHash
            )
              return yield* new SystemAssessmentError({
                message: 'Candidate capture differs from the configured account',
              })
            const accountConfig = { ...config, execution: { ...config.execution, brokerIdentity: accountIdentity } }
            const forward = yield* readForwardPerformanceInput(accountConfig, undefined, {
              authorityGenerationHash: definition.authorityGenerationHash,
            })
            const decisions = yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.decisions)(
              yield* systemDecisionQuery(sql, {
                accountId: accountIdentity.accountId,
                generationHash: definition.authorityGenerationHash,
                firstSession: first.sessionDate,
                lastSession: last.sessionDate,
              }),
            )
            const scope = {
              accountId: accountIdentity.accountId,
              generationHash: definition.authorityGenerationHash,
              firstSession: first.sessionDate,
              lastSession: last.sessionDate,
              asOf,
            }
            const protectionIntents = yield* readSystemProtectionIntents(
              scope,
              definition.riskPolicy.maxBrokerStateAgeMs,
            )
            const plans = yield* Effect.fromResult(executionOrderPlans(decisions, protectionIntents))
            const fills = yield* Effect.fromResult(
              captureExecutionFills(
                plans,
                yield* readSystemExecutionFills(scope, first.openAt, last.closeAt),
                accountIdentity.accountId,
                definition.authorityGenerationHash,
              ),
            )
            const cashObservations = yield* readSystemCashObservations(accountIdentity.accountId, {
              accountBindingHash: definition.accountBindingHash,
              openAt: first.openAt,
              closeAt: last.closeAt,
              asOf,
            })
            const inventory = yield* Effect.fromResult(prepareValuationInventory(forward))
            const observedTimes = new Set(cashObservations.map((mark) => mark.at))
            const scheduled = yield* Effect.forEach(
              requiredValuationTimes(registration.calendar.sessions, registeredMarkIntervalMs(registration)).filter(
                (at) => at <= asOf && !observedTimes.has(at),
              ),
              (at) =>
                Effect.gen(function* () {
                  const source = { accountBindingHash: definition.accountBindingHash, at, registrationHash }
                  return {
                    accountBindingHash: definition.accountBindingHash,
                    at,
                    availableAt: asOf,
                    cashMicros: null,
                    sourceHash: yield* Effect.fromResult(canonicalHashV1Result(source)),
                  }
                }),
            )
            const observations = [...cashObservations, ...scheduled].sort((a, b) => a.at.localeCompare(b.at))
            const holdingsByTime = new Map(observations.map((mark) => [mark.at, inventory.at(mark.at)]))
            const quoteRequests = [...holdingsByTime].flatMap(([at, holdings]) =>
              holdings === null || holdings.length === 0
                ? []
                : [{ at, symbols: holdings.map((position) => position.symbol) }],
            )
            const quotes = yield* readValuationQuotes(definition, quoteRequests)
            const accountMarks = yield* Effect.forEach(observations, (cash) =>
              Effect.gen(function* () {
                const holdings = holdingsByTime.get(cash.at)
                const positions =
                  holdings?.map((position) => {
                    const bid = executableBid(
                      quotes.get(cash.at)?.get(position.symbol),
                      position.symbol,
                      cash.at,
                      registration.obligations.configuration.protocol.maximumQuoteAgeMs,
                    )
                    return bid === null ? null : { ...position, ...bid }
                  }) ?? null
                const supported = positions?.filter((position) => position !== null) ?? []
                const valuation =
                  positions === null || supported.length !== positions.length
                    ? null
                    : {
                        inventorySourceHash: inventory.sourceHash,
                        positions: supported,
                      }
                return {
                  ...cash,
                  valuation,
                  sourceHash: yield* Effect.fromResult(canonicalHashV1Result({ cash, valuation })),
                }
              }),
            )
            const store = makeInferenceExpenseStore(sql, accountIdentity.accountId)
            const inferenceSnapshots = yield* Effect.forEach(registration.calendar.sessions, ({ sessionDate }) =>
              Effect.gen(function* () {
                const snapshot = yield* readInferenceExpenseSnapshot(sql, accountIdentity.accountId, sessionDate)
                yield* Effect.fromResult(
                  verifyInferenceExpenseCoverage(snapshot.evidence, accountIdentity.accountId, snapshot.quotes),
                )
                const ledger = yield* readInferenceExpenseLedger(client, snapshot, store.currentSession(sessionDate))
                return {
                  ...captureInferenceSnapshot(snapshot, registration.program),
                  ledger,
                }
              }),
            )
            if (
              forward.transactions.some(
                (t) =>
                  t.occurredAt >= first.openAt &&
                  t.occurredAt <= last.closeAt &&
                  (t.symbol === undefined ||
                    !registration.obligations.configuration.protocol.universe.includes(t.symbol) ||
                    !registration.calendar.tradingMarkets.includes(instrumentMarket(t.symbol))),
              ) ||
              decisions.some(({ document }) => !decisionMarketScopeSupported(document, registration))
            )
              return yield* new SystemAssessmentError({
                message: 'Captured market scope is incompatible with the registered policy and session windows',
              })
            const protectionDecisions = yield* Effect.forEach(protectionIntents, (intent) =>
              Effect.gen(function* () {
                const session = registration.calendar.sessions.find(
                  (session) =>
                    intent.riskDecision.decidedAt >= session.openAt && intent.riskDecision.decidedAt <= session.closeAt,
                )
                if (session === undefined)
                  return yield* new SystemAssessmentError({
                    message: 'Protection approval falls outside the registered sessions',
                  })
                return { sessionDate: session.sessionDate, decisionHash: intent.intentId }
              }),
            )
            const financial = yield* Effect.fromResult(
              captureForwardFinancialEvidence(registration, definition.policy, forward, {
                decisions: [
                  ...decisions.map(({ sessionDate, document }) => ({
                    sessionDate,
                    decisionHash: document.contentHash,
                  })),
                  ...protectionDecisions,
                ],
                fills,
              }),
            )
            accounts.push({
              policy: definition.policy,
              identity: accountIdentity,
              forward,
              decisions,
              protectionIntents,
              fills,
              accountMarks,
              cashObservations,
              valuationQuoteSources: [
                ...new Map(
                  [...quotes.values()].flatMap((bySymbol) =>
                    [...bySymbol.values()].map((quote) => [quote.recordHash, quote.source]),
                  ),
                ).values(),
              ],
              inferenceSnapshots,
              financial,
            })
          }
          const candidateAccount = accounts.find((account) => account.policy === JevResearchPolicy.Candidate)
          if (candidateAccount === undefined)
            return yield* new SystemAssessmentError({
              message: 'Registered candidate authority generation is unavailable',
            })
          const { decisions } = candidateAccount
          const mutations = yield* readSystemMutationEvidence(
            identity.accountId,
            candidate.authorityGenerationHash,
            first.openAt,
          )
          const batches = yield* readSystemBatchEvidence(
            identity.accountId,
            candidate.authorityGenerationHash,
            first.openAt,
            last.closeAt,
          )
          const controllerPasses = yield* readSystemControllerPasses(
            identity.identityHash,
            registration.obligations.configuration.controllerPlanHash,
            first.openAt,
            last.closeAt,
            asOf,
          )
          const durableObservations = yield* readSystemDurableObservations(registrationHash)
          const decisionAdmissions = yield* readSystemDecisionAdmissions({
            accountId: identity.accountId,
            generationHash: candidate.authorityGenerationHash,
            openAt: first.openAt,
            firstSession: first.sessionDate,
            lastSession: last.sessionDate,
            asOf,
          })
          const scope = {
            accountId: identity.accountId,
            generationHash: candidate.authorityGenerationHash,
            openAt: first.openAt,
            firstSession: first.sessionDate,
            lastSession: last.sessionDate,
            asOf,
          }
          const { protectionIntents, fills } = candidateAccount
          const plans = yield* Effect.fromResult(executionOrderPlans(decisions, protectionIntents))
          const orders = yield* Effect.fromResult(
            captureExecutionOrders(
              plans,
              yield* readSystemExecutionOrders(scope),
              identity.accountId,
              candidate.authorityGenerationHash,
            ),
          )
          const sourceAccounts = accounts.map(({ inferenceSnapshots, ...account }) => ({
            ...account,
            inferenceSnapshots: inferenceSnapshots.map(({ source, ledger }) => ({ ...source, ledger })),
          }))
          const sourceMaterial = {
            captureBuild: {
              sourceRevision: config.build.sourceRevision,
              imageRepository: config.build.imageRepository,
              imageDigest: config.build.imageDigest,
            },
            runtimeConfiguration,
            accounts: sourceAccounts,
            decisions,
            mutations,
            orders,
            protectionIntents,
            accountMarks: accounts.flatMap((account) => account.accountMarks),
            controllerPasses,
            durableObservations,
            decisionAdmissions,
          }
          return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema)({
            schemaVersion: 'bayn.system-source-cut.v4',
            decisionAdmissions,
            registrationHash,
            asOf,
            runtimeConfigurationHash,
            financial: accounts.map((account) => account.financial),
            inference: accounts.flatMap((account) =>
              account.inferenceSnapshots.flatMap((snapshot) => (snapshot.evidence === null ? [] : [snapshot.evidence])),
            ),
            inferenceLedgerEvidenceHash: yield* Effect.fromResult(
              canonicalHashV1Result(
                sourceAccounts.map((account) => ({
                  policy: account.policy,
                  snapshots: account.inferenceSnapshots,
                })),
              ),
            ),
            decisions,
            batches,
            mutations,
            fills,
            orders,
            protectionIntents,
            accountMarks: accounts.flatMap((account) => account.accountMarks),
            controllerPasses,
            durableObservations,
            sourceMaterial,
            sourceMaterialHash: yield* Effect.fromResult(canonicalHashV1Result(sourceMaterial)),
          })
        }),
      )
      const saved = yield* persistSystemSourceCut(cut)
      return {
        ...saved,
        controllerLatency: yield* Effect.fromResult(measureControllerLatency(registration, cut, identity)),
        fullBatchLatency: yield* Effect.fromResult(measureFullBatchLatency(registration, cut, identity)),
      }
    }),
  ).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'System source capture failed', cause })))
